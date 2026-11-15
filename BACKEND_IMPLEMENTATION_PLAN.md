# Kokoro speech server: implementation draft

Design draft — November 14, 2026. Backend-only companion to [the extension plan](TTS_EXTENSION_PLAN.md). Implementation is now authorized with PCM/WAV only. The [execution plan](BACKEND_EXECUTION_PLAN.md) supersedes the scheduling details below: one active job with busy rejection replaces the proposed waiting queue and thread-to-async bridge, favoring simpler code.

Wrap this repository's `KModel` and `KPipeline` in a Python HTTP server exposing `POST /v1/audio/speech`. The client points its OpenAI SDK at localhost; inference uses the downloaded Kokoro model. No requests go to OpenAI.

## Technology choices

**Recommendation: FastAPI + Uvicorn + Pydantic, with one dedicated inference worker thread in one process.** Use the existing PyTorch/NumPy stack for synthesis and PCM conversion, and Python's `wave` module for WAV output.

| Option | Why consider it? | Tradeoff for this project |
| --- | --- | --- |
| FastAPI + Uvicorn | Typed request validation, OpenAPI docs, async HTTP handling, streaming responses, application lifecycle hooks. | More framework machinery than a tiny hand-written server, but useful for a documented compatibility API. Recommended. |
| Starlette + Uvicorn | Small ASGI foundation with direct request/response control. | We would implement more validation and API documentation ourselves. Good if minimizing framework abstractions is the priority. |
| aiohttp | Async server with explicit streaming and lifecycle handling. | Viable, but less benefit here than FastAPI's schema-oriented API development. |
| Flask | Familiar synchronous routes and generator-based HTTP streaming. | Viable for a small local service, but less aligned with our async connection management and cancellation design. |

These are design judgments, not performance benchmarks. Framework overhead is unlikely to determine speech latency; model inference and text chunking should be measured first. Framework capabilities are documented in [FastAPI features](https://fastapi.tiangolo.com/features/), [FastAPI streaming](https://fastapi.tiangolo.com/advanced/stream-data/), [Starlette requests](https://www.starlette.io/requests/), [aiohttp server guide](https://docs.aiohttp.org/en/stable/web_quickstart.html), and [Flask streaming](https://flask.palletsprojects.com/en/stable/patterns/streaming/).

Additional choices:

- Use ordinary HTTP streamed audio bytes. WebSockets, SSE, Redis, Celery, a database, and a reverse proxy are unnecessary for the initial backend.
- Use `argparse` plus environment variables for configuration. A separate CLI framework is unnecessary.
- Add server dependencies as an optional `server` extra. Resolve and record tested versions during implementation; leave normal library users unaffected.
- Use pytest and HTTPX for API tests, with the OpenAI Python SDK as a development-only interoperability check.
- Start on CPU, using the environment where the existing script works. Add CUDA/MPS only after device-specific smoke tests; expose only validated devices.

## Compatibility contract

Implement a documented **subset** of OpenAI's Speech API. The official reference provides the request shape, formats, speed, and `stream_format` fields. Our model and voice identifiers remain Kokoro-specific. [OpenAI Speech reference](https://developers.openai.com/api/reference/resources/audio/subresources/speech/methods/create)

| Field | Initial local behavior |
| --- | --- |
| `model` | Required; accept `kokoro`. Reject other names. |
| `input` | Required, nonblank string, at most 4,096 characters. Preserve punctuation and paragraph breaks. |
| `voice` | Required; cached English voice name such as `af_heart` or `bf_emma`. Reject unknown names and arbitrary file paths. |
| `response_format` | `pcm` or `wav`; local default `wav`. This deliberately differs from OpenAI's MP3 default. Clients should set it explicitly. |
| `speed` | Finite number, default 1.0; initially 0.5–2.0, a narrower documented range than OpenAI. |
| `stream_format` | Accept omitted or `audio`. Reject `sse` until deliberately implemented. |
| `instructions` | Reject with an explanatory error; Kokoro does not implement prompted speaking styles. |
| Other fields | Reject unknown fields rather than implying unsupported behavior. |

There is no required `stream: true` flag for the binary response. The server streams PCM; the client chooses whether to consume incrementally or buffer it. OpenAI's SDK streaming wrapper controls how the client reads the response. WAV is a complete, correctly sized file generated before sending.

Example client, once implemented:

```python
import os
from openai import OpenAI

client = OpenAI(
    base_url="http://127.0.0.1:8880/v1",
    api_key=os.environ["KOKORO_API_KEY"],
)
with client.audio.speech.with_streaming_response.create(
    model="kokoro",
    input="Hello from the local speech server.",
    voice="af_heart",
    response_format="wav",
) as response:
    response.stream_to_file("speech.wav")
```

For incremental playback, request `pcm` and consume the bytes directly. The OpenAI-style endpoint is a useful compatibility convention; the server does not depend on hosted model availability.

### Format decision to discuss

**Recommended first milestone: PCM + WAV only.** PCM is simplest for the extension; WAV is convenient for inspection and saving audio. Neither needs an additional codec.

If broad, drop-in client compatibility is important, add MP3 and change the default to MP3 before calling the server compatible beyond this subset. Evaluate an in-process MP3 encoder against an FFmpeg subprocess: the former simplifies runtime management but adds a binary package dependency; the latter adds an executable and per-request process/pipe cleanup. Neither is required for our own Firefox client. Encoder choice remains open until we need MP3.

## Server layout and lifecycle

Proposed package:

```text
kokoro_server/
  __init__.py
  __main__.py      # CLI and Uvicorn launch
  app.py          # app factory, lifecycle, routes, auth/error handlers
  schemas.py      # request validation and response models
  engine.py       # cached model, voice registry, pipeline ownership
  worker.py       # bounded jobs, cancellation, result delivery
  audio.py        # float tensor → PCM, WAV container
tests/server/
```

Update the existing Hatch wheel configuration to include `kokoro_server`; currently it only packages `kokoro`. Add a `kokoro-server` console command while preserving the existing `kokoro` command and `generate_tts.py`.

Proposed installation and launch commands (not available yet):

```bash
python -m pip install -e '.[server]'
python -m kokoro_server --host 127.0.0.1 --port 8880 --device cpu
```

Read the shared token from `KOKORO_API_KEY`; fail with setup instructions if absent. Bind to loopback by default. Start one Uvicorn process without automatic reload in normal use: extra server workers would each load a model. [Uvicorn deployment](https://uvicorn.dev/deployment/)

Use FastAPI's lifespan hook to initialize the worker, load model/config from the Hugging Face cache with `local_files_only=True`, prepare supported English pipelines, and run a small warm-up. Start serving only after initialization succeeds; while loading, progress appears in the terminal, not an HTTP readiness response. Missing model or language resources should fail startup with actionable setup instructions. Prepare language resources during setup, not silently during a speech request. On shutdown, stop admitting work, cancel pending jobs, and close the worker after bounded cleanup. [FastAPI lifespan](https://fastapi.tiangolo.com/advanced/events/)

Load one `KModel`; reuse it across American/British English pipelines. Cache validated voice tensors by identifier. Keep model creation, inference, and pipeline mutation on the dedicated worker. Do not import/load the model as a module-level side effect.

## Request execution and streaming

1. Authenticate, validate JSON/body size, resolve model/voice/format, and check admission capacity.
2. Admit one active request and at most two waiting jobs initially. Return `429` with `Retry-After` when full. Give queued jobs a configurable wait deadline.
3. The dedicated worker iterates Kokoro's pipeline. A bounded thread-to-async bridge delivers audio to the response handler without blocking the event loop. Do not write to an `asyncio.Queue` directly from the inference thread; use a tested bridge with cancellation-aware backpressure.
4. Await the first PCM result before creating the streaming response, so initial synthesis failures and empty output still receive a structured error status.
5. Convert tensors to CPU, clip to [-1, 1], scale, and encode signed little-endian int16 mono at 24 kHz. Slice outgoing bytes into bounded, even-sized blocks; do not treat HTTP chunks as text or audio frame boundaries.
6. Stream subsequent PCM blocks or accumulate a bounded WAV payload. Release job resources on success, timeout, exception, or disconnect.

PCM headers: `Content-Type: application/octet-stream`, `Cache-Control: no-store`, and documented encoding/sample-rate/channel headers. No `Content-Length` for the unknown-length stream; let Uvicorn handle HTTP framing. WAV uses `audio/wav` and a correct RIFF header; never concatenate standalone WAV files.

Kokoro produces a complete audio tensor for each internal text chunk before yielding it. Network streaming cannot emit samples before that inference finishes. Reuse existing paragraph/phoneme chunking initially; clients can send short sentences for faster starts. Measure short and long inputs before introducing an additional sentence segmenter. [Local pipeline](kokoro/pipeline.py)

A single worker serializes inference, including voice/pipeline cache changes. FastAPI's normal synchronous thread pool is not a model concurrency policy; choose the dedicated worker explicitly. [Starlette thread pool](https://starlette.dev/threadpool/)

### Cancellation and limits

Connection cancellation sets a per-job cancellation flag, removes queued work, and unblocks producer/consumer waits. Check it before and after each inference step and while waiting to publish output. An active PyTorch forward pass generally cannot be interrupted safely: it may finish, but its output is discarded and no following chunk runs.

Keep admission capacity occupied until the underlying worker actually stops that job. Cancelling an awaiting coroutine must not accidentally permit simultaneous inference. Test disconnects while queued, awaiting first output, streaming, and blocked by a slow reader.

Bound request bytes, queued jobs, generated samples, and buffered output; a character limit alone is not an audio-memory limit. Set configurable queue, generation, and stalled-consumer deadlines. Start with conservative limits and tune from measurements. A separate worker process could provide stronger termination/isolation later, but adds IPC and model-restart complexity.

## Supporting endpoints and errors

- `GET /health`: minimal readiness status, responsive while synthesis runs.
- `GET /v1/models`: OpenAI-shaped list containing `kokoro`.
- `GET /v1/voices`: clearly documented local extension listing supported cached voices, language, and formats.

Use a consistent error object: `{"error": {"message": "...", "type": "invalid_request_error", "param": "voice", "code": "unsupported_voice"}}`. Map validation failures to `400`, authentication failures to `401`, capacity limits to `429`, and engine failures to `500`/`503` as appropriate. Override FastAPI's default validation response to honor this contract.

After HTTP headers have been sent, an error cannot become a JSON response. Terminate the stream abnormally and log the request ID; never append an error message to PCM or signal successful completion. Verify this behavior over a real socket. Audio already played cannot be undone; clients should not blindly retry partially consumed speech.

Protect speech and discovery routes with bearer auth. Permit a minimal unauthenticated health check. No wildcard CORS; configure allowed origins if needed for an extension client. Validate allowed hosts, and keep page text, tokens, and voice file paths out of routine logs. Log request ID, queue delay, first-audio latency, generated duration, total inference time, and completion/cancellation status.

## Implementation milestones

1. **Engine adapter and lifecycle:** model loaded once, cached voices, startup diagnostics, existing CLI preserved, optional server packaging. Smoke-test real English speech with cached assets.
2. **API and WAV:** request schema, authentication, errors, discovery, valid WAV response. Verify with curl and the OpenAI Python client.
3. **PCM streaming and scheduling:** dedicated worker, bounded queue/bridge, initial-error handling, cancellation, timeouts. Verify progressive delivery and responsive health checks while inference runs.
4. **Hardening and documentation:** limits, shutdown, real-socket failure tests, local startup guide, measured performance and supported compatibility subset.

Use a fake engine for deterministic tests of validation, queue saturation, backpressure, cancellation, and midstream errors. Run an actual Uvicorn subprocess for stream timing/disconnect tests: in-process HTTP test transports can buffer responses and conceal streaming bugs. Use the real model for a smaller integration check of WAV metadata, PCM length/encoding, nonempty audio, voice selection, and model reuse. Listen to short and multi-paragraph samples; byte-level assertions do not establish speech quality.

Acceptance: the OpenAI SDK can save a valid WAV and consume PCM incrementally; malformed inputs fail before audio; the server stays responsive under inference; stopping a request prevents later chunks and frees its capacity; repeated requests reuse the same model; slow clients and long input do not cause unbounded memory growth.

## Decisions for our discussion

Recommended baseline: **FastAPI/Uvicorn, one worker thread, PCM/WAV, English voices, optional dependencies in this repo.**

The most useful choice to settle is whether “OpenAI-compatible” means our documented speech subset or default behavior for arbitrary OpenAI clients. The latter makes MP3 support part of the first release. CPU versus MPS is a benchmarking decision; thread versus process is a cancellation/isolation decision. Neither needs to block the first working local endpoint.
