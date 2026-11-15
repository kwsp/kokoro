"""Local OpenAI-style speech API. PCM streams; WAV is returned as a complete file."""

import asyncio
import logging
import secrets
import uuid
from contextlib import asynccontextmanager
from typing import Annotated

from fastapi import Depends, FastAPI, Request
from fastapi.responses import JSONResponse, Response, StreamingResponse
from fastapi.security import HTTPAuthorizationCredentials, HTTPBearer
from pydantic import ValidationError
from starlette.middleware.trustedhost import TrustedHostMiddleware
from starlette.requests import ClientDisconnect

from .audio import to_wav
from .engine import KokoroEngine, UnknownVoiceError
from .schemas import SpeechRequest
from .worker import (
    AudioLimitError,
    BusyError,
    EmptyAudioError,
    ServiceClosedError,
    SpeechService,
    SynthesisTimeoutError,
)

logger = logging.getLogger(__name__)


class APIError(Exception):
    def __init__(self, status, message, code, param=None, headers=None):
        self.status = status
        self.message = message
        self.code = code
        self.param = param
        self.headers = headers


async def until_disconnected(operation, receive):
    """Run work after reading the body, cancelling it if the connection closes."""

    async def listen():
        while True:
            if (await receive())["type"] == "http.disconnect":
                return

    work = asyncio.create_task(operation)
    disconnect = asyncio.create_task(listen())
    try:
        done, _ = await asyncio.wait(
            (work, disconnect), return_when=asyncio.FIRST_COMPLETED
        )
        if disconnect in done:
            raise ClientDisconnect()
        return await work
    finally:
        for task in (work, disconnect):
            if not task.done():
                task.cancel()
        await asyncio.gather(work, disconnect, return_exceptions=True)


class PCMResponse(StreamingResponse):
    """Monitor disconnect even while waiting for inference, on all ASGI versions."""

    def __init__(self, first, job, headers):
        async def chunks():
            yield first
            async for chunk in job:
                yield chunk

        self.job = job
        super().__init__(
            chunks(), media_type="application/octet-stream", headers=headers
        )

    async def __call__(self, scope, receive, send):
        try:
            await until_disconnected(self.stream_response(send), receive)
        except (ClientDisconnect, OSError):
            pass
        except Exception:  # noqa: BLE001 - sanitize late engine errors before logging
            # A partial audio response must not be finished successfully or have
            # JSON appended. Let the ASGI server terminate the connection.
            logger.error(
                "Speech stream failed request_id=%s", self.headers["x-request-id"]
            )
            raise RuntimeError("Speech stream failed") from None
        finally:
            await self.body_iterator.aclose()
            await self.job.aclose()


def create_app(
    api_key: str,
    *,
    engine_factory=KokoroEngine,
    max_body_bytes=65_536,
    service_options=None,
    allowed_hosts=("127.0.0.1", "localhost", "[::1]"),
):
    if not isinstance(api_key, str) or not api_key.strip():
        raise ValueError("A nonblank API key is required")
    if not isinstance(max_body_bytes, int) or max_body_bytes <= 0:
        raise ValueError("max_body_bytes must be positive")

    @asynccontextmanager
    async def lifespan(app):
        service = SpeechService(engine_factory, **(service_options or {}))
        app.state.speech = service
        logger.info("Loading cached Kokoro model and warming up")
        try:
            await service.start()
            logger.info("Kokoro ready with %d voices", len(service.voices))
            yield
        finally:
            await service.close()

    app = FastAPI(title="Local Kokoro speech server", lifespan=lifespan)
    app.add_middleware(TrustedHostMiddleware, allowed_hosts=list(allowed_hosts))

    @app.exception_handler(APIError)
    async def api_error(request, error):
        return JSONResponse(
            {
                "error": {
                    "message": error.message,
                    "type": (
                        "server_error"
                        if error.status >= 500
                        else "invalid_request_error"
                    ),
                    "param": error.param,
                    "code": error.code,
                }
            },
            status_code=error.status,
            headers=error.headers,
        )

    bearer = HTTPBearer(auto_error=False)

    async def authenticate(
        credentials: Annotated[HTTPAuthorizationCredentials | None, Depends(bearer)],
    ):
        if credentials is None or not secrets.compare_digest(
            credentials.credentials.encode("utf-8"), api_key.encode("utf-8")
        ):
            raise APIError(
                401,
                "Invalid API key",
                "invalid_api_key",
                headers={"WWW-Authenticate": "Bearer"},
            )

    @app.get("/health")
    async def health():
        return {"status": "ready"}

    @app.get("/v1/models", dependencies=[Depends(authenticate)])
    async def models():
        return {
            "object": "list",
            "data": [
                {
                    "id": "kokoro",
                    "object": "model",
                    "created": 0,
                    "owned_by": "local",
                }
            ],
        }

    @app.get("/v1/voices", dependencies=[Depends(authenticate)])
    async def voices():
        return {
            "voices": [
                {"id": name, "language": language}
                for name, language in app.state.speech.voices.items()
            ],
            "formats": ["pcm", "wav"],
            "sample_rate": 24000,
            "channels": 1,
        }

    @app.post(
        "/v1/audio/speech",
        response_class=Response,
        dependencies=[Depends(authenticate)],
        responses={
            200: {
                "content": {
                    "audio/wav": {"schema": {"type": "string", "format": "binary"}},
                    "application/octet-stream": {
                        "schema": {"type": "string", "format": "binary"}
                    },
                }
            }
        },
        openapi_extra={
            "requestBody": {
                "required": True,
                "content": {
                    "application/json": {"schema": SpeechRequest.model_json_schema()}
                },
            }
        },
    )
    async def speech(request: Request):
        if (
            request.headers.get("content-type", "").split(";")[0].strip().lower()
            != "application/json"
        ):
            raise APIError(
                415, "Use Content-Type: application/json", "unsupported_media_type"
            )
        body = bytearray()
        try:
            async for chunk in request.stream():
                if len(body) + len(chunk) > max_body_bytes:
                    raise APIError(
                        413, "Request body is too large", "request_too_large"
                    )
                body.extend(chunk)
        except ClientDisconnect:
            return Response(status_code=499)
        try:
            value = SpeechRequest.model_validate_json(body)
        except ValidationError as exc:
            error = exc.errors(include_input=False)[0]
            param = str(error["loc"][0]) if error["loc"] else None
            raise APIError(400, error["msg"], "invalid_request", param) from None

        job = None
        handed_off = False
        request_id = uuid.uuid4().hex
        headers = {
            "Cache-Control": "no-store",
            "X-Request-Id": request_id,
            "X-Audio-Encoding": "pcm_s16le",
            "X-Sample-Rate": "24000",
            "X-Channels": "1",
        }

        async def prepare():
            first = await anext(job)
            if value.response_format == "pcm":
                return first
            pcm = bytearray(first)
            async for chunk in job:
                pcm.extend(chunk)
            return to_wav(bytes(pcm))

        try:
            job = app.state.speech.open(value)
            data = await until_disconnected(prepare(), request.receive)
            if value.response_format == "pcm":
                response = PCMResponse(data, job, headers)
                handed_off = True
                return response
            return Response(data, media_type="audio/wav", headers=headers)
        except ClientDisconnect:
            return Response(status_code=499)
        except UnknownVoiceError:
            raise APIError(
                400, "Unknown or uncached English voice", "unsupported_voice", "voice"
            ) from None
        except BusyError:
            raise APIError(
                429,
                "Another speech request is active; retry shortly",
                "server_busy",
                headers={"Retry-After": "1"},
            ) from None
        except EmptyAudioError:
            raise APIError(
                400, "No audio was generated for this input", "empty_audio", "input"
            ) from None
        except AudioLimitError:
            raise APIError(
                400,
                "Generated audio exceeds the configured limit",
                "audio_limit",
                "input",
            ) from None
        except (ServiceClosedError, SynthesisTimeoutError):
            raise APIError(
                503, "Speech service unavailable or timed out", "service_unavailable"
            ) from None
        except Exception:  # noqa: BLE001 - API boundary sanitizes engine failures
            logger.error("Speech generation failed request_id=%s", request_id)
            raise APIError(500, "Speech generation failed", "synthesis_error") from None
        finally:
            if job is not None and not handed_off:
                await job.aclose()

    return app
