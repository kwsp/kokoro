# Backend implementation steps

Accepted scope: local FastAPI/Uvicorn server, OpenAI-style speech endpoint, PCM and WAV only. Prefer simple, maintainable code. Each step is assigned to a subagent, which must report changed files, tests and results, and limitations before the next step starts. The primary agent reviews and integrates each report.

This execution plan refines `BACKEND_IMPLEMENTATION_PLAN.md`: use **one active synthesis job and reject overlapping requests with 429**, rather than adding a waiting-job queue and producer/consumer bridge. Pull the next chunk from a single dedicated executor thread when the client is ready. This bounds buffering and preserves model serialization with fewer moving parts. Cancellation must retain the active slot until an in-flight operation finishes.

## Step 1 — Core adapter, formats, and request contract

- Add `kokoro_server` package with no model-loading import side effects.
- Implement validated speech request schema: kokoro, English cached voice identifiers, 1–4096 nonblank characters, PCM/WAV, speed 0.5–2.0, audio stream format only. Reject unsupported fields.
- Implement PCM conversion and WAV wrapping; test clipping, little-endian samples, format headers, and invalid audio.
- Implement reusable cached Kokoro engine: CPU only for this first pass, one model, English pipelines and voice reuse, cache-only model/voice loading, actionable missing-resource errors.
- Unit-test with injected/mocked model dependencies; do not download assets in unit tests.
- Add optional server and test dependencies, package inclusion, and install dependencies for validation.

## Step 2 — Serial inference and streaming lifecycle

- Add a small async service around one dedicated executor thread. Initialize and use the engine on that thread.
- Admit one job; return a clear busy error for concurrent work. Iterate lazily with a sentinel for generator completion.
- Keep inference off the event loop; release capacity safely on completion/error/cancellation, including cancellation during `next()`.
- Bound generated audio and individual output writes; provide configurable operation deadlines and reliable cleanup. No arbitrary thread termination.
- Unit-test serialization, busy admission, responsiveness, cancellation during inference, generator cleanup, empty output, output limits, failures and shutdown.

## Step 3 — HTTP API, CLI, and lifecycle

- Add app factory/lifespan, CLI, env-token setup, loopback binding, health/models/voices routes.
- Implement bearer auth, body-size and schema validation, OpenAI-shaped errors, first-chunk error handling, PCM streaming and complete WAV responses.
- Handle disconnects before first output and during streaming; do not report truncated audio as successful completion.
- Add API/CLI unit tests for the important success/error paths. Preserve existing library and script behavior.

## Step 4 — Integration verification and user guide

- Test streaming, disconnection, responsiveness and midstream errors over an actual Uvicorn socket with a fake engine.
- Test OpenAI SDK compatibility for explicit PCM/WAV requests.
- Run real cached-model HTTP smoke tests and inspect WAV/PCM output; measure startup and warm requests without imposing speculative performance targets.
- Write concise startup, API, limitations, and test instructions; record actual results and supported scope.
- Run the full appropriate test suite and inspect packaging. Fix issues discovered during integration and report them.

## Progress reports

Reports below are filled after each step is reviewed. Per the user's follow-up, the primary agent commits each completed step using the existing global Git author configuration. No external publication is required.

### Step 1 report — core adapter and formats

- Implemented `kokoro_server` core modules, strict request validation, PCM/WAV conversion, cached English voice discovery, reusable model/pipelines/voice tensors, and startup checks that prevent automatic language downloads.
- Added optional server/test dependency groups and included `kokoro_server` in the wheel. The primary agent installed dependencies after the subagent's network approval was interrupted. Existing `uv.lock` changes were preserved.
- Validation: `.venv/bin/python -m pytest tests/server/test_core.py -q` — **41 passed**. Tests cover schema boundaries, unsupported requests, audio encoding/headers, malformed audio, cache-only lookup, missing assets/language resources, model/pipeline/voice reuse, and empty warmup.
- Interface for Step 2: `KokoroEngine(device="cpu")`; `.voices` maps voice IDs to language codes; `.synthesize(SpeechRequest)` yields PCM byte chunks; `.warmup()` exhausts a short synthesis. `EngineSetupError` and `UnknownVoiceError` identify setup and registry failures. Construction/synthesis are synchronous and must be serialized by the caller.
- Remaining work: worker, HTTP routes and CLI do not exist yet; no real-model smoke test was run in this step.
