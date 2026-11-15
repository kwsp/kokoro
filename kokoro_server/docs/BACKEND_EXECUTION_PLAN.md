# Backend implementation steps

Accepted scope: local FastAPI/Uvicorn server, OpenAI-style speech endpoint, PCM and WAV only.
Prefer simple, maintainable code.
Each step is assigned to a subagent, which must report changed files, tests and results, and limitations before the next step starts.
The primary agent reviews and integrates each report.

This execution plan refines `BACKEND_IMPLEMENTATION_PLAN.md`: use **one active synthesis job and reject overlapping requests with 429**, rather than adding a waiting-job queue and producer/consumer bridge.
Pull the next chunk from a single dedicated executor thread when the client is ready.
This bounds buffering and preserves model serialization with fewer moving parts.
Cancellation must retain the active slot until an in-flight operation finishes.

## Step 1 - Core adapter, formats, and request contract

- Add `kokoro_server` package with no model-loading import side effects.
- Implement validated speech request schema: kokoro, English cached voice identifiers, 1–4096 nonblank characters, PCM/WAV, speed 0.5–2.0, audio stream format only.
  Reject unsupported fields.
- Implement PCM conversion and WAV wrapping; test clipping, little-endian samples, format headers, and invalid audio.
- Implement reusable cached Kokoro engine: CPU only for this first pass, one model, English pipelines and voice reuse, cache-only model/voice loading, actionable missing-resource errors.
- Unit-test with injected/mocked model dependencies; do not download assets in unit tests.
- Add optional server and test dependencies, package inclusion, and install dependencies for validation.

## Step 2 - Serial inference and streaming lifecycle

- Add a small async service around one dedicated executor thread.
  Initialize and use the engine on that thread.
- Admit one job; return a clear busy error for concurrent work.
  Iterate lazily with a sentinel for generator completion.
- Keep inference off the event loop; release capacity safely on completion/error/cancellation, including cancellation during `next()`.
- Bound generated audio and individual output writes; provide configurable operation deadlines and reliable cleanup.
  No arbitrary thread termination.
- Unit-test serialization, busy admission, responsiveness, cancellation during inference, generator cleanup, empty output, output limits, failures and shutdown.

## Step 3 - HTTP API, CLI, and lifecycle

- Add app factory/lifespan, CLI, env-token setup, loopback binding, health/models/voices routes.
- Implement bearer auth, body-size and schema validation, OpenAI-shaped errors, first-chunk error handling, PCM streaming and complete WAV responses.
- Handle disconnects before first output and during streaming; do not report truncated audio as successful completion.
- Add API/CLI unit tests for the important success/error paths.
  Preserve existing library and script behavior.

## Step 4 - Integration verification and user guide

- Test streaming, disconnection, responsiveness and midstream errors over an actual Uvicorn socket with a fake engine.
- Test OpenAI SDK compatibility for explicit PCM/WAV requests.
- Run real cached-model HTTP smoke tests and inspect WAV/PCM output; measure startup and warm requests without imposing speculative performance targets.
- Write concise startup, API, limitations, and test instructions; record actual results and supported scope.
- Run the full appropriate test suite and inspect packaging.
  Fix issues discovered during integration and report them.

## Step 5 - Apple Silicon acceleration (requested during implementation)

- Add automatic device selection: prefer MPS on Apple Silicon when PyTorch reports it available; use CPU otherwise, and retain an explicit CPU override.
- Enable PyTorch's MPS fallback before importing Torch in the server process, since unsupported model operations may still execute on CPU.
- Test device selection with unit tests and real HTTP PCM/WAV requests on this Mac's Apple GPU, including repeated requests and model reuse.
- Update startup/status documentation to report the selected device and explain fallback behavior.
- Run Black, Ruff, and the appropriate tests, then commit the reviewed step using the global Git author.

## Progress reports

Reports below are filled after each step is reviewed.
Per the user's follow-up, the primary agent commits each completed step using the existing global Git author configuration.
No external publication is required.

### Step 1 report - core adapter and formats

- Implemented `kokoro_server` core modules, strict request validation, PCM/WAV conversion, cached English voice discovery, reusable model/pipelines/voice tensors, and startup checks that prevent automatic language downloads.
- Added optional server/test dependency groups and included `kokoro_server` in the wheel.
  The primary agent installed dependencies after the subagent's network approval was interrupted.
  Existing `uv.lock` changes were preserved.
- Validation: `.venv/bin/python -m pytest tests/server/test_core.py -q` - **41 passed**.
  Tests cover schema boundaries, unsupported requests, audio encoding/headers, malformed audio, cache-only lookup, missing assets/language resources, model/pipeline/voice reuse, and empty warmup.
- Interface for Step 2: `KokoroEngine(device="cpu")`; `.voices` maps voice IDs to language codes; `.synthesize(SpeechRequest)` yields PCM byte chunks; `.warmup()` exhausts a short synthesis.
  `EngineSetupError` and `UnknownVoiceError` identify setup and registry failures.
  Construction/synthesis are synchronous and must be serialized by the caller.
- Remaining work: worker, HTTP routes and CLI do not exist yet; no real-model smoke test was run in this step.

### Step 2 report - serial inference and streaming lifecycle

- Added `kokoro_server/worker.py`: a single dedicated executor initializes and owns the engine, pulls PCM only on demand, and rejects overlapping jobs.
  Completed model chunks are divided into bounded writes; total audio output is capped.
- Cancellation schedules generator cleanup after any in-flight operation.
  The active slot remains occupied until cleanup actually finishes.
  Operation/startup/shutdown waits are configurable and bounded, with late exceptions consumed after cancellation.
- Added `tests/server/test_worker.py` covering reuse/thread ownership, admission, event-loop responsiveness, cancel/close races, timeouts, empty/invalid/excess audio, cumulative limits, failures, bounded shutdown, and configuration validation.
- Validation: `.venv/bin/python -m pytest tests/server -q` - **62 passed** (41 core + 21 worker).
  `git diff --check` passed.
- Interface for Step 3: `SpeechService(engine_factory=KokoroEngine, ...)`; `await start()`; `job = open(SpeechRequest)`; `await anext(job)` and `async for chunk in job`; `await job.aclose()` in a `finally`; `await service.close()`.
  Discovery uses `.voices`; admission state uses `.busy`.
  Specific errors identify busy/not-ready, empty output, audio limit, and operation timeout.
- Limitation: Python cannot safely kill an in-progress inference thread.
  Shutdown stops waiting after its deadline, but process exit may still wait for that native operation to finish.
  No waiting request queue, producer bridge, or global watchdog was added.

### Step 3 report: HTTP API and CLI

- Added `kokoro_server/app.py` and `__main__.py`, bearer authentication, OpenAI-shaped request errors, actual body-byte limits, loopback Host validation, health/model/voice discovery, PCM streaming, and complete WAV responses.
- Added first-output error handling and disconnect monitoring before response headers, during WAV collection, and during PCM streaming.
Late stream failures terminate the response and sanitize internal error messages.
- The CLI reads `KOKORO_API_KEY`, defaults to `127.0.0.1:8880`, and runs one Uvicorn worker without reload.
The `kokoro-server` console entry is included in package metadata.
- Added API/CLI tests and OpenAPI authorization/binary response documentation.
The primary agent also formatted and lint-fixed the existing core/worker modules and tests for the new formatting requirement.
- Validation: **102 server tests passed** (41 core, 21 worker, 34 API, 6 CLI).
Black check and Ruff check pass for `kokoro_server` and `tests/server`.
- Interface for Step 4: `create_app(api_key, engine_factory=KokoroEngine, max_body_bytes=65536, service_options=None, allowed_hosts=("127.0.0.1", "localhost", "[::1]"))`.
The injected factory supports fake-engine real-socket tests.
Run `python -m kokoro_server --host 127.0.0.1 --port 8880 --device cpu` or the installed `kokoro-server` entry point.
- Remaining validation: real Uvicorn sockets, installed OpenAI SDK interoperability, wheel inspection, and real-model HTTP tests are assigned to Step 4.

### Step 4 report - integration verification and user guide

- Added real Uvicorn HTTP tests for incremental PCM delivery, responsive health checks, busy rejection, disconnects before/during audio, and incomplete HTTP responses after midstream failures.
  OpenAI Python SDK tests pass for explicit PCM and WAV requests.
- Added an opt-in cached-model HTTP test validating WAV headers, nonempty PCM, and engine reuse.
  CPU startup including warm-up took 4.21 seconds; warm requests generated 2.48 seconds of audio in 0.33 seconds for WAV and 0.30 seconds for PCM.
- Built the wheel without isolation and verified it contains both packages and both console entry points.
  Added `SERVER.md` and a README link with setup, startup, curl/SDK examples, API limits, and test commands.
- Reproduced and fixed the two inherited `CustomSTFT` failures through a dedicated regression subagent.
  Corrected inverse bin scaling, overlap-add normalization, shorter-window centering, and output-length handling while retaining convolution-based operations.
  All 15 STFT tests now pass, including DC/Nyquist, odd FFT, shorter-window, and partial-hop regressions.
  ONNX export was not exercised.
- Final verification: `.venv/bin/python -m pytest tests -q` - **123 passed, 1 skipped**.
  The skipped cached-model HTTP test was run separately with `KOKORO_TEST_REAL_MODEL=1` and passed.
  Black, Ruff, and `git diff --check` pass for all changed Python files.
  Explicit project-local formatting/lint configuration makes the checks reproducible.
- GitHub issues are disabled on `kwsp/kokoro`, preventing the parent workspace's issue-linked workflow.
  Work continues on `feat/kokoro-speech-backend` with the configured global author; agents made no commits or external publications.
- Remaining limits: one active job, CPU only at this step, no MP3/SSE, no forced interruption of native inference, and no separate slow-reader deadline.
  Apple Silicon support is assigned to the follow-up step requested by the user.

### Step 5 report - Apple Silicon acceleration

- Added `auto`, `cpu`, and `mps` device selection.
  The default prefers MPS only on Apple Silicon when PyTorch reports GPU access; other environments use CPU.
  Explicit unavailable MPS fails with an actionable CPU override message.
- Set `PYTORCH_ENABLE_MPS_FALLBACK=1` before Torch or spaCy is imported for MPS setup.
  Health responses and startup logging expose the selected device.
  Embedding callers who import Torch first must configure fallback before that import.
- Added unit tests for Apple/non-Apple selection, unavailable MPS, forced CPU, early fallback setup, and CLI argument forwarding.
  Preserved the opt-in CPU regression and added repeated MPS HTTP synthesis plus a fresh CLI subprocess test without caller-provided fallback configuration.
- Unit verification: **113 passed** for core, worker, API, CLI, and device tests.
  Black and Ruff pass for the server and its tests.
- The primary agent ran the hardware tests outside the sandbox to permit GPU access: **2 passed in 34.54 seconds**.
  Actual model placement remained on MPS, WAV/PCM output was nonempty and valid, and the engine was reused.
  The default CLI selected MPS without a preset fallback environment variable.
- MPS startup including warm-up took 16.05 seconds.
  Four requests each generated 2.48 seconds of audio, taking 2.07, 0.26, 0.26, and 0.25 seconds respectively.
  PyTorch reported expected CPU fallback for `aten::angle`; MPS mode still uses CPU for unsupported operators.
- No CUDA support or performance-specific pipeline changes were added.
  CPU remains explicitly selectable with `--device cpu`.
- Final complete suite: **134 passed, 3 skipped**.
  All three opt-in hardware checks passed separately: two MPS tests and the explicit CPU HTTP test.
  The final CPU check loaded in 3.08 seconds and generated 2.48 seconds of audio in 0.29 seconds for WAV and 0.28 seconds for PCM.
