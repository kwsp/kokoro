# Kokoro Firefox reader development

The extension is being implemented according to [IMPLEMENTATION.md](IMPLEMENTATION.md).
Step 1 provides a working Firefox foundation; complete article reading and playback controls are added in subsequent steps.

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
The development foundation reads an explicit selection or the first article/main paragraph after clicking Play.
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
The test captures a screenshot while speech is playing and verifies that the highlight clears after a real Web Audio end event.
It activates the installed extension through Firefox's real Extensions menu using browser-chrome automation.
The test directory retains `speaking.png`, `final.png`, `browser-controls.json`, `server-history.json`, and the geckodriver log for diagnosis.
The artifacts omit request authorization headers and options-page HTML.
The Alt+Shift+K shortcut and selection context menu still need a normal-browser acceptance check because automated key routing did not activate the browser action reliably in headless Firefox.
Audible speaker output still requires a manual listening check.
