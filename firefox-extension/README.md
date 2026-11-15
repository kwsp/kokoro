# Kokoro Firefox reader development

The extension is being implemented according to [IMPLEMENTATION.md](IMPLEMENTATION.md).
Steps 1 through 3 provide article and selection reading with sentence highlights, pause/resume, Stop, and Retry.
Click-to-read and the remaining lifecycle handling are added in subsequent steps.

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
Activation without a selection reads visible prose from a suitable article or main element, including headings, lists, and quotations.
Pages without those semantic roots use Mozilla Readability on a detached clone.
The retained text must map uniquely to ordered visible source blocks; ambiguous articles or mappings offer selection reading instead.
Navigation, controls, hidden content, editable regions, and unrelated sidebars are excluded.
Only a closed details element's summary is read until that element is opened.
Selections inside shadow roots are outside this version's top-level-document scope.

The current sentence has a gold highlight and underline, while Pause uses a muted highlight and dotted underline.
The original page selection is preserved.
If the CSS Highlight API is unavailable, the reader outlines the current block and reports “Block highlight”; Stop or Close restores the previous outline.
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
Unit tests also cover semantic root selection, conservative Readability mappings, preservation of the source DOM, outline restoration, Unicode/whitespace offsets, long segment splitting, disjoint selections, audio-clock offsets, stale network/decode callbacks, request validation, and the combined 32 MiB raw/decoded audio limit.
It activates the installed extension through Firefox's real Extensions menu, Alt+Shift+K command, and selection context menu using browser-chrome automation.
The test directory retains `speaking.png`, `final.png`, `browser-controls.json`, `server-history.json`, and the geckodriver log for diagnosis.
The artifacts omit request authorization headers and options-page HTML.
The shortcut test dispatches the command in browser chrome because WebDriver content-page key events do not reliably reach extension commands.
Audible speaker output still requires a manual listening check.

## Readability build and validation

[Mozilla Readability](https://github.com/mozilla/readability) is the only runtime package dependency.
The build copies its unchanged `Readability.js` into the extension and injects it before the content bundle in Firefox's isolated content-script world.
A small build-only adapter lets source code and unit tests keep the normal package import.
The dependency's license and the repository's Apache license are included in the built extension.

`web-ext lint` excludes only the unchanged vendor file because Readability internally assigns HTML while processing its detached clone, triggering two generic unsafe-assignment warnings.
All application bundles remain covered by web-ext validation, ESLint, and TypeScript.
The application never inserts Readability's output HTML into the live page; it uses normalized text to find the original source ranges.
The browser tests verify that extraction leaves the original page DOM intact and that the vendor global is not exposed to page scripts.
The outline-fallback test installs a separate temporary build with `Highlight` defined as unavailable at build time.
This simulates the missing API while using the same manifest, permissions, real activation path, and fallback implementation.
The ordinary build and the other Firefox tests use runtime feature detection; no test commands are exposed to the page.
