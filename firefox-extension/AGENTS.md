# Firefox extension agent workflow

This file supplements the repository and user instructions.
Prefer simple, robust, maintainable solutions and preserve existing user changes.

## Ownership and Git

- Start by inspecting `git status --short`, the current branch, and relevant instructions and changes before editing.
- Check for an existing issue with `gh issue list` and create one if needed when the repository permits it.
- The `kwsp/kokoro` issue tracker has been observed to be disabled, so if that remains true, report the limitation and proceed on a dedicated branch without inventing an issue.
- Delegate execution to the requested Terra model, currently `gpt-6.1-terra`, when delegation is available and authorized.
- Do not silently substitute another model if the requested model is unavailable; report the limitation and follow the user's instructions.
- Give each agent a bounded step, ownership of specific files, an isolated worktree and branch, relevant context, and expected verification and report.
- Review and integrate each reported step in the parent worktree before committing it.
- Commit each logical step using the existing global Git author, and check the author configuration without changing it.
- Run the relevant lint and Black checks before every commit, along with the other checks appropriate to the step.
- Never commit directly to main or push or merge without user authorization.
- Preserve unrelated dirty files and never overwrite or clean a user's work to prepare a branch or test run.

## Code map and invariants

All source paths below are relative to `firefox-extension/src/`.

- `content.ts` wires the reader together, `ui/controls.ts` renders controls and diagnostics, and `speech/session.ts` owns playback state, buffering, cancellation, and generation changes.
- `speech/audio.ts` handles audio playback, `speech/transport.ts` sends requests, and `speech/coordinator.ts` and `background.ts` coordinate ownership and serialized backend access across tabs.
- `reading/selection.ts`, `reading/extraction.ts`, `reading/mapping.ts`, and `reading/highlighting.ts` map readable text and sentence highlights to original DOM ranges; `reading/readability-vendor.ts` adapts the injected vendor script.
- `reading/mouse.ts` handles click-to-read targeting, `reading/source-watch.ts` watches changes, and `settings.ts` and `ui/options.ts` manage settings and the options page. `assets/icon.svg` is the extension icon.
- Preserve the original page DOM and exact sentence ranges, including UTF-16 offsets, whitespace, inline nodes, and the user's selection.
- Explicit selections and click-to-read may read visible editable document text, but automatic extraction must exclude editors and unsent composers.
- Preserve normal interactive controls, modified and non-primary clicks, and drag selections; click mode only intercepts eligible text clicks.
- Keep one active reading owner and one serial backend synthesis request, with cancellation and generation ownership preventing stale work from playing or changing state.
- Start the first sentence promptly and read ahead toward 15 seconds of decoded future audio or eight future sentences while maintaining the 32 MiB logical audio budget.
  The final sentence can exceed the duration target because its duration is known only after generation.
- Keep timers and diagnostics accurate, and avoid rewriting the DOM when the rendered state has not changed.
- Do not expose page hooks, backend tokens, or test-only controls to page scripts.

## Reproduction and verification

Reproduce bugs first through the installed extension in real Firefox as closely as possible to the user's action.
Use deterministic local fixtures for regressions, including contenteditable and ChatGPT- or Reddit-style structures when relevant, and add meaningful unit coverage for important behavior.
Fix failures and flakes rather than weakening assertions.
Run focused tests first and the full suite when appropriate to the scope; do not repeat an already passing full suite without a reason.
Documentation-only changes do not require unrelated browser regressions, but lint and Black still run before each commit.

From `firefox-extension`, install dependencies with `npm ci` only when needed, then run the applicable checks:

```bash
npm run typecheck
npm run lint
npm run format:check
npm test
npm run build
npm run lint:extension
npm run package
```

Use `npm run format` to apply formatting when needed.
The web-ext lint exclusion applies only to unchanged vendor `Readability.js`; investigate application warnings.
An `update-notifier.config` warning is not a reason to use chmod or sudo.
`dist/` and the unsigned ZIP in `artifacts/` are generated artifacts for temporary installation, not signed releases.

From the repository root, install Python dependencies if needed.
The E2E requirements provide Selenium; use the root server and server-test extras for pytest, Black, and Ruff as described in `SERVER.md`.
Run Black formatting and Ruff before each commit:

```bash
.venv/bin/python -m pip install -e '.[server,server-test]'
.venv/bin/python -m pip install -r firefox-extension/tests/e2e/requirements.txt
.venv/bin/python -m black firefox-extension/tests/e2e
.venv/bin/python -m black --check firefox-extension/tests/e2e
.venv/bin/python -m ruff check firefox-extension/tests/e2e
```

Build before browser tests, and keep sources and `dist/` unchanged throughout a run so that its installed XPI matches the tested build.
Run browser suites serially to avoid interference and noisy timing measurements.
Pytest can delete the contents of `--basetemp`, so give it a new dedicated directory rather than an existing or valuable path:

```bash
TEST_TMP=$(mktemp -d /tmp/kokoro-firefox-pytest.XXXXXX)
.venv/bin/python -m pytest firefox-extension/tests/e2e/test_buffering.py -q -s --basetemp "$TEST_TMP"
```

Replace the focused test path as appropriate, and use `firefox-extension/tests/e2e` for the full deterministic suite.
The deterministic suite skips opt-in real-backend cases by default; report those skips accurately.
Create a fresh `TEST_TMP` for each run, including real-backend runs.
The harness installs an XPI in actual Firefox with a fresh profile, a dynamic-port local HTTP fixture, and `reader.test` mapped to loopback.
It uses `--allow-system-access` for browser-chrome automation and isolates the macOS application-data home with `CFFIXED_USER_HOME`; never use the user's Firefox profile.
Selenium Manager can locate geckodriver, or `GECKODRIVER` can point to a verified executable, such as `/tmp/kokoro-selenium-cache/geckodriver/mac-arm64/0.37.1/geckodriver` if present.
Optionally set `SE_CACHE_PATH=/tmp/kokoro-selenium-cache` to choose its cache.
Set `FIREFOX_BINARY` when Firefox is not at the harness default.
Firefox runs headless by default; set `FIREFOX_HEADED=1` and run `firefox-extension/tests/e2e/test_presentation.py` for visual inspection.
Socket, browser, or GPU access may require sandbox approval; the primary agent handles escalations without weakening profile isolation or other protections.

For changes affecting real synthesis or playback, run the opt-in CPU and automatic-device cases with cached model and language resources:

```bash
TEST_TMP=$(mktemp -d /tmp/kokoro-firefox-pytest.XXXXXX)
KOKORO_TEST_REAL_EXTENSION=1 .venv/bin/python -m pytest firefox-extension/tests/e2e/test_real_server.py -q -s --basetemp "$TEST_TMP"
```

Use the full `firefox-extension/tests/e2e` path with the same opt-in environment variable when a complete real-backend suite is warranted.
Check the server health result and verify that automatic selection uses MPS on supported Apple Silicon.
Review headed screenshots and actual controls for relevant light and dark pages, narrow widths, zoom, and keyboard use.
Artifacts omit authorization headers but may contain fixture text, screenshots, and logs, so do not capture private real-page data or secrets.
Distinguish UI preparation waits from audible silence and total request or preparation times from model inference time or percentages.

For manual installation, load `dist/manifest.json` as a temporary add-on from `about:debugging`.
After a relevant build, instruct the user to reload the temporary add-on and refresh the page before retrying on the actual affected site.
Request a manual listening check when speaker output or voice quality matters and automation cannot establish it.
Update `README.md`, `IMPLEMENTATION.md`, and `PERFORMANCE.md` when their user instructions, implementation record, or measurements change, and report only test counts and results actually verified in the current run.
