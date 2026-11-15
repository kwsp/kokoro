# Local Kokoro speech server

This server wraps the repository's Kokoro model with an OpenAI-style `POST /v1/audio/speech` endpoint.
It runs locally on CPU, keeps one model loaded, and supports English voices with PCM and WAV output.
No OpenAI account or API request is involved.

## Setup and startup

From this repository, activate the existing virtual environment and install the server extra:

```bash
source .venv/bin/activate
python -m pip install -e '.[server]'
```

Prepare the model and English language resource if they are not already installed:

```bash
hf download hexgrad/Kokoro-82M
python -m spacy download en_core_web_sm
```

Start the server with a local shared token of your choice:

```bash
export KOKORO_API_KEY='replace-with-your-local-token'
python -m kokoro_server
```

The installed `kokoro-server` command is equivalent.
The default address is `http://127.0.0.1:8880`; use `--port` to change it.
Only loopback binding and CPU are supported in this first version.
The server loads cached model files and warms up before accepting requests.
Missing model or English resources cause a startup error with setup instructions; requests never trigger downloads.
Use Ctrl+C to stop it.

## Generate speech

```bash
curl --fail-with-body http://127.0.0.1:8880/v1/audio/speech \
  -H "Authorization: Bearer $KOKORO_API_KEY" \
  -H 'Content-Type: application/json' \
  -d '{"model":"kokoro","input":"Hello from Kokoro.","voice":"af_heart","response_format":"wav"}' \
  --output speech.wav
```

Use `response_format: "pcm"` for incremental audio consumption.
PCM is headerless, signed little-endian 16-bit, 24 kHz, mono.
It is not a WAV file and needs those format parameters when played.
WAV responses contain a complete file with correct length headers and are buffered until generation finishes.

OpenAI Python client example (install `openai` separately, or use the test extra):

```python
import os
from openai import OpenAI

with OpenAI(
    base_url="http://127.0.0.1:8880/v1",
    api_key=os.environ["KOKORO_API_KEY"],
    max_retries=0,
) as client:
    with client.audio.speech.with_streaming_response.create(
        model="kokoro",
        input="Hello from the local speech server.",
        voice="af_heart",
        response_format="wav",
    ) as response:
        response.stream_to_file("speech.wav")
```

For PCM, set `response_format="pcm"` and consume `response.iter_bytes()` with your audio player.
Network reads can divide 16-bit samples across boundaries, so retain any trailing byte until the next read.
There is no `stream: true` request field.

## Supported API

| Endpoint | Behavior |
| --- | --- |
| `GET /health` | Unauthenticated readiness response, available after startup completes. |
| `GET /v1/models` | Authenticated OpenAI-shaped model list containing `kokoro`. |
| `GET /v1/voices` | Authenticated local extension listing cached English voices and formats. |
| `POST /v1/audio/speech` | Authenticated speech generation. |
| `GET /docs` | Interactive API documentation with bearer-token authorization. |

Required speech fields are `model: "kokoro"`, `input`, and `voice`.
Use `/v1/voices` to discover available identifiers such as `af_heart` and `bf_emma`.
The local default format is WAV, unlike OpenAI's MP3 default, so clients should request their format explicitly.

| Constraint | First-version behavior |
| --- | --- |
| Formats | `pcm`, `wav`; no MP3 or SSE. |
| Speed | Finite number from 0.5 to 2.0, default 1.0. |
| Text | Nonblank, maximum 4,096 characters. |
| Body | Maximum 65,536 received bytes. |
| Concurrency | One active job; another receives `429` and `Retry-After: 1`. |
| Audio output | Maximum five minutes at 24 kHz mono int16. |
| Inference waits | 60 seconds per operation; startup 120 seconds; cleanup wait five seconds. |
| Unsupported requests | Unknown fields, style instructions, foreign model IDs, arbitrary voice paths, and non-English voices are rejected. |

The byte limits and deadlines can be configured through `create_app(..., service_options=...)` when embedding the app.
The CLI intentionally exposes only host, port, and device.

Kokoro returns completed audio chunks, not samples during a still-running model operation.
PCM streams those chunks as they become available; short sentence requests can reduce initial latency.
The server pulls chunks on demand and keeps buffering bounded, but a connected slow reader can occupy the one active slot.
There is no separate slow-reader deadline in this first version.

Disconnecting cancels later chunks and closes the generator after any current model operation finishes.
Python cannot safely stop an already running native inference call; capacity remains reserved until cleanup completes, and process exit can wait for that call.

Errors before audio starts use `{"error": {"message": "...", "type": "...", "param": null, "code": "..."}}`.
Validation failures return `400`, invalid tokens `401`, oversized bodies `413`, non-JSON input `415`, busy state `429`, and initial engine failures `500`/`503`.
If a PCM stream fails after bytes were sent, the HTTP response ends incompletely instead of appending JSON or claiming success.
Do not automatically replay partly consumed speech after a transport error.

The server does not enable cross-origin browser access; Firefox should request it from the extension context with the required loopback host permission.
Logs include Uvicorn request status and sanitized request IDs for generation failures; page text and tokens are not intentionally logged.
Detailed latency measurements are provided by the opt-in smoke test, not a production metrics system.

## Tests, formatting, and lint

```bash
python -m pip install -e '.[server,server-test]'
python -m pytest tests -q
python -m black --check kokoro_server tests/server kokoro/custom_stft.py tests/test_custom_stft.py
python -m ruff check kokoro_server tests/server kokoro/custom_stft.py tests/test_custom_stft.py
```

The default suite uses fake engines for server tests, including actual loopback HTTP connections and OpenAI SDK requests.
The HTTP tests require permission to bind a local socket.
The real-model smoke test is opt-in and requires the model/language resources prepared above:

```bash
KOKORO_TEST_REAL_MODEL=1 python -m pytest tests/server/test_http_integration.py::test_real_cached_model_over_http -q -s
```

During verification on this machine, startup including warm-up took 4.21 seconds.
The warm WAV request generated 2.48 seconds of audio in 0.33 seconds; the PCM request generated 2.48 seconds in 0.30 seconds.
These measurements are examples, not performance guarantees.

The implementation steps and validation reports are in [BACKEND_EXECUTION_PLAN.md](BACKEND_EXECUTION_PLAN.md).
