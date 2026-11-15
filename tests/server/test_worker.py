import asyncio
import threading

import pytest

from kokoro_server.engine import UnknownVoiceError
from kokoro_server.schemas import SpeechRequest
from kokoro_server.worker import (
    AudioLimitError, BusyError, EmptyAudioError, ServiceClosedError,
    SpeechService, SynthesisTimeoutError,
)


def request(**kwargs):
    return SpeechRequest(model="kokoro", input="Hello.", voice="af_heart", **kwargs)


class Engine:
    voices = {"af_heart": "a"}

    def __init__(self, synthesize=lambda: iter([b"\x01\x00" * 4])):
        self.generate = synthesize
        self.threads = [threading.get_ident()]
        self.closed = False
        self.calls = 0

    def warmup(self):
        self.threads.append(threading.get_ident())

    def synthesize(self, value):
        self.calls += 1
        self.threads.append(threading.get_ident())
        try:
            yield from self.generate()
        finally:
            self.threads.append(threading.get_ident())
            self.closed = True


async def wait_until(predicate):
    async def poll():
        while not predicate():
            await asyncio.sleep(0.001)
    await asyncio.wait_for(poll(), 2)


@pytest.mark.asyncio
async def test_lifecycle_reuses_engine_and_thread_with_bounded_blocks():
    instances = []

    def factory():
        value = Engine()
        instances.append(value)
        return value

    service = SpeechService(factory, block_bytes=2)
    with pytest.raises(ServiceClosedError):
        service.open(request())
    await service.start()
    try:
        for _ in range(2):
            job = service.open(request())
            assert service.busy
            assert [chunk async for chunk in job] == [b"\x01\x00"] * 4
            assert not service.busy
        assert len(instances) == 1
        engine = instances[0]
        assert engine.calls == 2
        assert len(set(engine.threads)) == 1
        assert engine.threads[0] != threading.get_ident()
        with pytest.raises(ServiceClosedError):
            await service.start()
    finally:
        await service.close()
    await service.close()
    with pytest.raises(ServiceClosedError):
        service.open(request())


@pytest.mark.asyncio
async def test_busy_and_unknown_voice_admission_and_unstarted_close():
    engine = Engine()
    service = SpeechService(lambda: engine)
    await service.start()
    try:
        with pytest.raises(UnknownVoiceError):
            service.open(SpeechRequest(model="kokoro", input="Hi", voice="af_unknown"))
        job = service.open(request())
        with pytest.raises(BusyError):
            service.open(request())
        await job.aclose()
        assert not service.busy
        assert engine.calls == 0
        with pytest.raises(StopAsyncIteration):
            await anext(job)
    finally:
        await service.close()


@pytest.mark.asyncio
async def test_cancellation_keeps_slot_until_inflight_next_and_cleanup_finish():
    entered = threading.Event()
    release = threading.Event()

    def generate():
        entered.set()
        release.wait(5)
        yield b"\0\0"
        pytest.fail("Cancelled job should not generate its next chunk")

    engine = Engine(generate)
    service = SpeechService(lambda: engine, shutdown_timeout=0.02)
    await service.start()
    job = service.open(request())
    reading = asyncio.create_task(anext(job))
    try:
        await wait_until(entered.is_set)
        # The event loop remains responsive while inference blocks the thread.
        assert service.busy
        reading.cancel()
        with pytest.raises(asyncio.CancelledError):
            await reading
        await job.aclose()  # Bounded wait, rather than blocking for the thread.
        with pytest.raises(BusyError):
            service.open(request())
        assert not engine.closed
        release.set()
        await wait_until(lambda: not service.busy)
        assert engine.closed
        next_job = service.open(request())
        await next_job.aclose()
    finally:
        release.set()
        await service.close()


@pytest.mark.asyncio
async def test_timeout_keeps_slot_until_inflight_operation_finishes():
    release = threading.Event()

    def generate():
        release.wait(5)
        yield b"\0\0"

    engine = Engine(generate)
    service = SpeechService(lambda: engine, operation_timeout=0.02)
    await service.start()
    job = service.open(request())
    try:
        with pytest.raises(SynthesisTimeoutError):
            await anext(job)
        assert service.busy
        release.set()
        await wait_until(lambda: not service.busy)
        assert engine.closed
    finally:
        release.set()
        await service.close()


@pytest.mark.asyncio
async def test_close_during_inference_discards_result_and_consumes_late_failure():
    entered = threading.Event()
    release = threading.Event()

    def generate():
        entered.set()
        release.wait(5)
        raise RuntimeError("late failure")
        yield  # Make a generator whose first next() fails.

    engine = Engine(generate)
    service = SpeechService(lambda: engine, shutdown_timeout=0.02)
    await service.start()
    job = service.open(request())
    task = asyncio.create_task(anext(job))
    try:
        await wait_until(entered.is_set)
        with pytest.raises(RuntimeError, match="one consumer"):
            await anext(job)
        task.cancel()
        with pytest.raises(asyncio.CancelledError):
            await task
        await job.aclose()
        assert service.busy
        release.set()
        await wait_until(lambda: not service.busy)
        assert engine.closed
        # Cleanup also tolerates repeated close calls.
        await job.aclose()
    finally:
        release.set()
        await service.close()


@pytest.mark.asyncio
@pytest.mark.parametrize("chunks, expected", [
    ([], EmptyAudioError), ([b""], EmptyAudioError),
    ([b"\0\0" * 3], AudioLimitError), ([b"x"], ValueError),
    ([None], ValueError),
])
async def test_empty_invalid_and_excess_audio_close_generator(chunks, expected):
    engine = Engine(lambda: iter(chunks))
    service = SpeechService(lambda: engine, max_audio_bytes=4)
    await service.start()
    try:
        job = service.open(request())
        with pytest.raises(expected):
            await anext(job)
        await job.aclose()
        assert engine.closed
        assert not service.busy
    finally:
        await service.close()


@pytest.mark.asyncio
async def test_cumulative_output_limit():
    service = SpeechService(lambda: Engine(lambda: iter([b"\0\0"] * 3)), max_audio_bytes=4)
    await service.start()
    try:
        job = service.open(request())
        assert await anext(job) == b"\0\0"
        assert await anext(job) == b"\0\0"
        with pytest.raises(AudioLimitError):
            await anext(job)
        await job.aclose()
    finally:
        await service.close()


@pytest.mark.asyncio
async def test_midstream_engine_failure_propagates_and_releases():
    def generate():
        yield b"\0\0"
        raise RuntimeError("synthesis failed")

    engine = Engine(generate)
    service = SpeechService(lambda: engine)
    await service.start()
    try:
        job = service.open(request())
        assert await anext(job) == b"\0\0"
        with pytest.raises(RuntimeError, match="synthesis failed"):
            await anext(job)
        await job.aclose()
        assert engine.closed and not service.busy
    finally:
        await service.close()


@pytest.mark.asyncio
async def test_shutdown_closes_idle_generator_and_prevents_more_reads():
    engine = Engine(lambda: iter([b"\0\0"] * 3))
    service = SpeechService(lambda: engine)
    await service.start()
    job = service.open(request())
    assert await anext(job) == b"\0\0"
    await service.close()
    assert engine.closed
    with pytest.raises(StopAsyncIteration):
        await anext(job)


@pytest.mark.asyncio
async def test_shutdown_is_bounded_when_inference_is_inflight():
    entered = threading.Event()
    release = threading.Event()

    def generate():
        entered.set()
        release.wait(5)
        yield b"\0\0"

    engine = Engine(generate)
    service = SpeechService(lambda: engine, shutdown_timeout=0.02)
    await service.start()
    job = service.open(request())
    task = asyncio.create_task(anext(job))
    try:
        await wait_until(entered.is_set)
        await asyncio.wait_for(service.close(), 0.2)
        assert not engine.closed
        release.set()
        with pytest.raises(StopAsyncIteration):
            await task
        await wait_until(lambda: not service.busy)
        assert engine.closed
    finally:
        release.set()
        await service.close()


@pytest.mark.asyncio
async def test_startup_failure_propagates_and_service_is_closed():
    def fail():
        raise RuntimeError("setup failed")

    service = SpeechService(fail)
    with pytest.raises(RuntimeError, match="setup failed"):
        await service.start()
    with pytest.raises(ServiceClosedError):
        service.open(request())


@pytest.mark.asyncio
async def test_startup_timeout():
    release = threading.Event()

    def factory():
        release.wait(5)
        return Engine()

    service = SpeechService(factory, startup_timeout=0.02, shutdown_timeout=0.02)
    try:
        with pytest.raises(asyncio.TimeoutError):
            await service.start()
    finally:
        release.set()
        await service.close()


@pytest.mark.parametrize("kwargs", [
    {"operation_timeout": 0}, {"startup_timeout": float("inf")},
    {"shutdown_timeout": -1}, {"max_audio_bytes": 3}, {"block_bytes": 0},
])
def test_invalid_configuration(kwargs):
    with pytest.raises(ValueError):
        SpeechService(**kwargs)
