"""Pull-based synthesis on one thread, with no waiting request queue."""

import asyncio
import math
import threading
from concurrent.futures import ThreadPoolExecutor

from .engine import KokoroEngine, UnknownVoiceError
from .schemas import SpeechRequest


class BusyError(RuntimeError):
    pass


class ServiceClosedError(RuntimeError):
    pass


class SynthesisTimeoutError(RuntimeError):
    pass


class EmptyAudioError(RuntimeError):
    pass


class AudioLimitError(RuntimeError):
    pass


_END = object()


class SpeechService:
    """One resident engine; one active job until its generator is closed.

    Construct and use this object on one asyncio event loop. All engine work,
    including generator cleanup, runs on the same dedicated thread.
    """

    def __init__(
        self,
        engine_factory=KokoroEngine,
        *,
        operation_timeout=60.0,
        startup_timeout=120.0,
        shutdown_timeout=5.0,
        max_audio_bytes=24_000 * 2 * 300,
        block_bytes=16_384,
    ):
        for value in (operation_timeout, startup_timeout, shutdown_timeout):
            if not math.isfinite(value) or value <= 0:
                raise ValueError("Timeouts must be finite and positive")
        for value in (max_audio_bytes, block_bytes):
            if (
                not isinstance(value, int)
                or isinstance(value, bool)
                or value <= 0
                or value % 2
            ):
                raise ValueError("Audio byte limits must be positive even integers")
        self._factory = engine_factory
        self.operation_timeout = operation_timeout
        self.startup_timeout = startup_timeout
        self.shutdown_timeout = shutdown_timeout
        self.max_audio_bytes = max_audio_bytes
        self.block_bytes = block_bytes
        self.voices = {}
        self.device = "unknown"
        self._executor = ThreadPoolExecutor(max_workers=1, thread_name_prefix="kokoro")
        self._engine = None
        self._active = None
        self._started = False
        self._closed = False

    @property
    def busy(self):
        return self._active is not None

    async def start(self):
        if self._started or self._closed:
            raise ServiceClosedError("Service cannot be started again")
        self._started = True

        def initialize():
            self._engine = self._factory()
            self._engine.warmup()
            return dict(self._engine.voices), getattr(self._engine, "device", "unknown")

        future = asyncio.wrap_future(self._executor.submit(initialize))
        try:
            self.voices, self.device = await asyncio.wait_for(
                asyncio.shield(future), self.startup_timeout
            )
        except BaseException:
            # Consume late failures if initialization outlives a cancelled startup.
            future.add_done_callback(_consume_exception)
            await self.close()
            raise

    def open(self, request: SpeechRequest):
        """Reserve immediately; callers must close the returned job in finally."""
        if self._closed or not self.voices:
            raise ServiceClosedError("Speech service is not ready")
        if request.voice not in self.voices:
            raise UnknownVoiceError(f"Unknown or uncached voice: {request.voice}")
        if self.busy:
            raise BusyError("Another speech request is active; retry shortly")
        self._active = SpeechJob(self, request)
        return self._active

    async def close(self):
        """Bound waiting, but never attempt to kill a running model thread."""
        if self._closed:
            return
        self._closed = True
        if self._active is not None:
            self._active._begin_close()

        def dispose():
            self._engine = None

        future = asyncio.wrap_future(self._executor.submit(dispose))
        try:
            await asyncio.wait_for(asyncio.shield(future), self.shutdown_timeout)
        except asyncio.TimeoutError:
            pass
        finally:
            future.add_done_callback(_consume_exception)
            self._executor.shutdown(wait=False)


def _consume_exception(future):
    if not future.cancelled():
        future.exception()


class SpeechJob:
    def __init__(self, service, request):
        self._service = service
        self._request = request
        self._iterator = None
        self._buffer = b""
        self._offset = 0
        self._total = 0
        self._cancelled = threading.Event()
        self._cleanup = None
        self._reading = False

    def __aiter__(self):
        return self

    def _next(self):
        """Called only on the engine thread, including buffer/iterator mutation."""
        if self._cancelled.is_set():
            return _END
        if self._iterator is None:
            self._iterator = iter(self._service._engine.synthesize(self._request))
        while not self._cancelled.is_set():
            if self._offset < len(self._buffer):
                end = self._offset + self._service.block_bytes
                block = self._buffer[self._offset : end]
                self._offset += len(block)
                return block
            self._buffer = b""
            self._offset = 0
            chunk = next(self._iterator, _END)
            if chunk is _END:
                return _END
            if not isinstance(chunk, bytes) or len(chunk) % 2:
                raise ValueError(
                    "Engine must yield complete 16-bit PCM samples as bytes"
                )
            self._total += len(chunk)
            if self._total > self._service.max_audio_bytes:
                raise AudioLimitError("Generated audio exceeds the configured limit")
            self._buffer = chunk
        return _END

    async def __anext__(self):
        if self._cleanup is not None:
            raise StopAsyncIteration
        if self._reading:
            raise RuntimeError("Read a speech job from only one consumer")
        self._reading = True
        future = asyncio.wrap_future(self._service._executor.submit(self._next))
        try:
            chunk = await asyncio.wait_for(
                asyncio.shield(future), self._service.operation_timeout
            )
            if chunk is _END:
                await self.aclose()
                if not self._total:
                    raise EmptyAudioError("Kokoro produced no audio for this input")
                raise StopAsyncIteration
            if self._cancelled.is_set():
                raise StopAsyncIteration
            return chunk
        except asyncio.TimeoutError as exc:
            self._begin_close()
            raise SynthesisTimeoutError(
                "Speech generation exceeded the operation deadline"
            ) from exc
        except BaseException:
            self._begin_close()
            raise
        finally:
            future.add_done_callback(_consume_exception)
            self._reading = False

    def _begin_close(self):
        if self._cleanup is not None:
            return
        self._cancelled.set()

        def cleanup():
            try:
                if self._iterator is not None:
                    close = getattr(self._iterator, "close", None)
                    if close:
                        close()
            finally:
                self._iterator = None
                self._buffer = b""

        # Executor ordering guarantees close() never races an in-flight next().
        self._cleanup = asyncio.wrap_future(self._service._executor.submit(cleanup))

        def released(future):
            if self._service._active is self:
                self._service._active = None
            _consume_exception(future)

        self._cleanup.add_done_callback(released)

    async def aclose(self):
        self._begin_close()
        # Shield cleanup from request cancellation. The slot stays reserved until
        # the callback runs, even if the caller times out or disconnects.
        try:
            await asyncio.wait_for(
                asyncio.shield(self._cleanup), self._service.shutdown_timeout
            )
        except asyncio.TimeoutError:
            pass
