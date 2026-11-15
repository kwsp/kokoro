# Kokoro Firefox reader development

The extension is being implemented according to [IMPLEMENTATION.md](IMPLEMENTATION.md).
Steps 1 and 2 provide selection reading with sentence highlights, pause/resume, Stop, and Retry.
Full article extraction and click-to-read are added in subsequent steps.

## Build and checks

```bash
cd firefox-extension
npm ci
npm run typecheck
npm run lint
npm run format:check
npm test
npm run build
npm run lint:extension
```

Load `dist/manifest.json` through Firefox's `about:debugging` temporary add-on loader, or use `npm run dev`.
The extension opens its settings page when first installed.
Configure the loopback server URL and token, then use Alt+Shift+K or the toolbar button on a page to display the reader.
Select a passage across ordinary page text and activate Kokoro with the toolbar action, Alt+Shift+K, or the “Read selection with Kokoro” context menu.
Press Play in the compact reader bar.
The selected text is split into sentences, and only the current sentence is highlighted while audio plays.
Pause keeps the current sentence and exact audio offset; Resume continues from there without another request.
Stop cancels pending work and resets to the beginning of the selected passage.
Retry repeats the current sentence after an error.
A fresh selection followed by activation replaces the reading scope without creating another control bar.
Until article extraction is implemented, activation without a selection reads the first article/main paragraph.
No audio starts merely because the extension is activated.

## Installed-extension test

Install the Python test dependency from the repository root:

```bash
.venv/bin/python -m pip install -r firefox-extension/tests/e2e/requirements.txt
.venv/bin/python -m pytest firefox-extension/tests/e2e -q -s
```

Build the extension before running the test.
The harness uses actual Firefox, geckodriver, a temporary installed XPI, a fresh profile, a deterministic local WAV server, and a page on `reader.test` mapped to loopback by the test profile.
That page is outside the extension's backend host permissions, so user-triggered activation must provide page access.
Selenium Manager obtains geckodriver when needed; set `GECKODRIVER` to use an existing executable and `SE_CACHE_PATH` to choose its cache.
Set `FIREFOX_BINARY` to override the default macOS Firefox path and `FIREFOX_HEADED=1` to inspect the browser visually.

The test grants geckodriver system access so it can operate the extension's own options page in recent Firefox releases.
This applies only to the isolated automation process and does not add permissions to the extension.
On macOS, the test also isolates Firefox's application-data home to avoid accessing the user's profile or requiring Full Disk Access.
The suite captures speaking and paused screenshots and verifies actual Web Audio completion, exact selection highlights, sequential requests, cancellation, and recoverable audio errors.
Failure artifacts contain the control state, driver log, sanitized request history, and screenshots, without authorization headers.
Unit tests cover Unicode/whitespace offsets, long segment splitting, disjoint selections, audio-clock offsets, stale network/decode callbacks, request validation, and the combined 32 MiB raw/decoded audio limit.
It activates the installed extension through Firefox's real Extensions menu, Alt+Shift+K command, and selection context menu using browser-chrome automation.
The test directory retains `speaking.png`, `final.png`, `browser-controls.json`, `server-history.json`, and the geckodriver log for diagnosis.
The artifacts omit request authorization headers and options-page HTML.
The shortcut test dispatches the command in browser chrome because WebDriver content-page key events do not reliably reach extension commands.
Audible speaker output still requires a manual listening check.
