# Kokoro Firefox reader

Read articles or selected text aloud with the local Kokoro server, with sentence highlighting and a compact page control bar.
This personal-use extension sends text only to the server you configure and does not require an OpenAI account.
See [IMPLEMENTATION.md](docs/IMPLEMENTATION.md) for implementation and verification reports and [REFACTOR_PLAN.md](docs/REFACTOR_PLAN.md) for the refactor sequence.

## Start the local server

From the repository root, install the server extra and prepare the cached model and English language resource if needed:

```bash
source .venv/bin/activate
python -m pip install -e '.[server]'
hf download hexgrad/Kokoro-82M
python -m spacy download en_core_web_sm
export KOKORO_API_KEY='replace-with-your-local-token'
python -m kokoro_server
```

The default address is `http://127.0.0.1:8880`.
For a server on another machine on a trusted LAN, start it with `--host 0.0.0.0` and enter its address, such as `http://sadhamster2.local:8880`, in the extension settings. The browser will ask for access to that server host when you save or test the connection. See the [server guide](../kokoro_server/README.md) for firewall and HTTPS guidance.
Wait for server startup to finish, and keep that terminal running while you use the extension.
The default device is automatically MPS on supported Apple Silicon or CPU elsewhere; `--device cpu` forces CPU.
See [server guide](../kokoro_server/README.md) for setup, device selection, and endpoint details.

## Install for personal use

Build with Node.js and npm:

```bash
cd firefox-extension
npm ci
npm run build
```

1. Open `about:debugging#/runtime/this-firefox` in Firefox.
2. Choose **Load Temporary Add-on**, then select this directory's `dist/manifest.json`.
3. In the extension settings, enter the server address and the same local token used above.
4. Use **Test connection** to confirm access and refresh available voices. Choose one from **Available voices** or enter a voice manually, set the speed, then save. Saved credentials load the voice list automatically when you reopen settings. In the reading workspace, use **Edit text** to change the passage, then **Done**. Play, pause, resume or stop reading, or select a sentence to read from that point. Playback uses the current fields without requiring a save.
5. On an ordinary webpage, click Kokoro in Firefox's Extensions menu or use **Alt+Shift+K**, then press **Play** in the page bar.

Pin Kokoro to the toolbar from Firefox's Extensions menu if you want one-click access.
Temporary add-ons are removed when Firefox restarts, so repeat the loading step for your next session.
After rebuilding, use **Reload** in `about:debugging` and reload the reading page.
`npm run dev` instead starts a separate development Firefox profile.
`npm run package` creates an unsigned ZIP in `artifacts/` that can also be selected by the temporary add-on loader.
This development artifact is not a signed permanent Firefox add-on.

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

The extension entry points are `src/background.ts`, `src/content.ts`, and `src/ui/options.ts`. The `src/ui/` directory holds the toolbar and options page. Page text, selection, and highlighting are in `src/reading/`. Playback, transport, and ownership coordination are in `src/speech/`.

The build bundles toolbar CSS into the shadow root and highlight CSS into the content script. The options page links to its packaged CSS file.

Esbuild compiles the Svelte UI with the compiler's DOM-tree fragment mode. Vitest compiles toolbar components with the same fragment mode and uses the Svelte browser runtime. Run `npm run typecheck` to check both TypeScript and Svelte components.

## Read and interact

The extension opens its settings page when first installed.
Select a passage across ordinary page text and activate Kokoro with the toolbar action, Alt+Shift+K, or the “Read selection with Kokoro” context menu.
Press Play in the compact reader bar.
The selected text is split into sentences, and only the current sentence is highlighted while audio plays.
Pause keeps the current sentence and exact audio offset; Resume continues from there without another request.
Stop cancels pending work and resets to the beginning of the selected passage.
Retry repeats the current sentence after an error.
A fresh selection while the bar is open changes its primary button to **Read selection**; press it to replace the reading scope without reactivating the extension.
Selecting text alone does not start or interrupt speech.
Selections are retained before the controls receive focus, including editors that clear their native selection on blur.
Explicit selection reading supports visible `contenteditable` document text, such as notes in a document editor, while hidden content and native form controls remain excluded.
A fresh selection followed by toolbar, shortcut, or context-menu activation also replaces the reading scope without creating another control bar.
Activating again with the same retained selection focuses the existing bar and preserves playback.
Activation without a selection reads visible prose from a suitable article, main element, or ARIA main landmark, including headings, lists, and quotations.
Multiple article turns within one main landmark are read in document order, which supports conversation layouts without choosing only the longest turn.
Pages without those semantic roots use Mozilla Readability on a detached clone.
The retained text must map uniquely to ordered visible source blocks; ambiguous articles or mappings offer selection reading instead.
Automatic page extraction excludes navigation, controls, hidden content, editable regions, and unrelated sidebars, including unsent message composers.
Only a closed details element's summary is read until that element is opened.
Selections inside shadow roots are outside this version's top-level-document scope.

The current sentence has a gold highlight and underline, while Pause uses a muted highlight and dotted underline.
The original page selection is preserved.
If the CSS Highlight API is unavailable, the reader outlines the current block and reports “Block highlight”; Stop or Close restores the previous outline.
No audio starts merely because the extension is activated.

Enable **Click to read** to preview a sentence under the pointer and click it to start reading there.
The bar shows “Click a sentence · Esc to exit” while the mode is enabled, and explains clicks that do not target a readable sentence.
You do not need to press Play first.
Enabling the mode adopts a newly selected passage directly, without requiring Read selection first.
The mode uses the current reading scope, so selection reading stays within the selected passage.
Click mode supports prose inside focusable containers and editable documents.
Without a selected passage, hovering editable text previews its containing document, article, or main landmark, falling back to that editor when no such landmark exists.
Hovering does not interrupt playback or send editor text to the server; clicking starts at the chosen sentence and continues through that document scope.
Only one editor preview is retained, and text or visibility changes invalidate it.
Normal Play still excludes editors and unsent composers until a passage is explicitly selected or editor text is clicked in this mode.
Seeking works while preparing, playing, or paused and discards obsolete audio.
The green hover preview has lower priority than the speaking highlight.
Press Escape to leave click mode without stopping playback.
Stop clears the preview and resets reading while leaving click mode enabled; toggle the button or press Escape to return to ordinary clicking.
Links, buttons, form inputs, details toggles, modified clicks, right/middle clicks, and drag selections keep their normal behavior.
While click mode is enabled, ordinary clicks on editable document text start speech; turn the mode off or press Escape to restore normal editing clicks.
Clicks outside actual text rectangles do not select a nearby sentence.
When the Highlight API is absent, click seeking still works with the spoken-block outline, but hover preview is unavailable.

Only one page reads at a time, including paused pages that retain audio.
Starting or resuming another page stops the previous one.
Audio continues when its tab is in the background; navigation, closing the tab, Stop, or Close cancels its work.
Changing voice, speed, token, or endpoint restarts the current sentence with the new settings; paused reading stays paused and uses the new settings when resumed.
Saving unchanged values preserves playback.
If the source text, visibility, or relevant page structure changes, the reader stops with “Page changed”; press **Play** to refresh the same reading scope.
Selection refresh stays within the retained DOM ranges, and removing the selected nodes may require a fresh selection.

The reader requests complete WAV files from `/v1/audio/speech` and uses Web Audio's playback clock to advance highlights.
While the current sentence plays, it fetches and decodes future sentences serially until it has about 15 seconds buffered or eight future sentences, whichever comes first.
The final sentence can cross the duration target because its length is known only after generation.
The first sentence starts as soon as it is ready, without waiting for the future buffer to fill.
Ready sentences advance immediately, and highlights follow playback rather than preparation.
The combined logical raw, streaming assembly, and decoded audio budget stays within 32 MiB.
The background serializes synthesis requests across tabs and waits for an aborted fetch to settle before starting another.
Server cancellation is cooperative, so a current model operation may finish after Stop.
The extension retries busy responses for up to 5 seconds, respecting `Retry-After`. If the server remains busy, Retry is available for the same sentence. A new seek cancels the previous retry.
An unsuccessful prefetch is discarded and the unread sentence gets a normal request when needed.

## Current limits

- English voices supported by the local server; sentence highlighting rather than word timing.
- Top-level HTML documents and ordinary DOM text; Firefox internal pages, PDF viewers, cross-origin frames, and shadow-root selections are outside this version's scope.
- Conservative article extraction may ask for a manual selection on ambiguous or highly dynamic pages.
- Gaps can still occur when synthesis exhausts the available read-ahead buffer, especially immediately after starting or seeking.
- HTTP or HTTPS endpoints, with a shared token stored in Firefox extension settings; the token is not included in page controls or content-script messages.
- The 32 MiB budget covers retained raw audio, streaming assembly, and decoded samples; browser-internal copies and garbage collection are outside the extension's control.

The short-sentence diagnosis, implementation steps, CPU/MPS measurements, and playback regression commands are in [PERFORMANCE.md](docs/PERFORMANCE.md).

## Installed-extension test

Install the Python test dependency from the repository root:

```bash
.venv/bin/python -m pip install -r firefox-extension/tests/e2e/requirements.txt
.venv/bin/python -m pytest firefox-extension/tests/e2e -q -s
.venv/bin/python -m black --check firefox-extension/tests/e2e
.venv/bin/python -m ruff check firefox-extension/tests/e2e
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
Pointer tests check interactive-target policy, exact caret/rectangle matching, drag detection, canceled hover frames, and seek transitions from playing or paused audio.
Firefox cases use real pointer coordinates on wrapped inline text, actual drag selection, delayed speech responses, and ordinary page controls.
It activates the installed extension through Firefox's real Extensions menu, Alt+Shift+K command, and selection context menu using browser-chrome automation.
The test directory retains `speaking.png`, `final.png`, `browser-controls.json`, `server-history.json`, and the geckodriver log for diagnosis.
The artifacts omit request authorization headers and options-page HTML.
The shortcut test dispatches the command in browser chrome because WebDriver content-page key events do not reliably reach extension commands.
Audible speaker output still requires a manual listening check.

Ownership and lifecycle cases check cross-tab handoff, cached-audio Resume, background playback, navigation, source replacement, settings changes, prefetch timing, and recovery after busy responses, bad tokens, and unavailable servers.
Presentation cases capture light/dark pages, a narrow viewport, and 200% Firefox zoom, and check Tab, Space, Escape, and Enter through the real controls.

Run the opt-in real-backend tests after caching the model and language resource:

```bash
KOKORO_TEST_REAL_EXTENSION=1 .venv/bin/python -m pytest firefox-extension/tests/e2e/test_real_server.py -q -s
FIREFOX_HEADED=1 .venv/bin/python -m pytest firefox-extension/tests/e2e/test_presentation.py -q -s
```

The real-backend suite starts isolated servers on dynamic ports for CPU and automatic device selection, checks `/health`, and exercises actual Kokoro WAV playback, pause/resume, click seeking, and completion in installed Firefox.
On Apple Silicon the automatic case expects MPS.
The ordinary deterministic suite skips these slower tests unless explicitly enabled.
The backend regression suite remains available with `.venv/bin/python -m pytest tests/server -q` from the repository root.

## Manual listening check

1. Start the local server, temporarily load the extension, and test the connection in Settings.
2. Read a familiar article and confirm intelligible speech, comfortable volume, and highlights following the spoken sentence.
3. Pause and resume mid-sentence, then use Click to read to jump forward and confirm obsolete speech stops.
4. Start another tab and confirm only that page speaks; return to the first tab and try Resume or Play.
5. Change the voice or speed during reading and confirm the current sentence restarts with that setting.
6. Stop, close the bar, and navigate away, checking that speaker output stops each time.

Automation checks real audio completion and highlight timing but cannot establish what comes out of your speakers or how a chosen voice sounds to you.

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

The reader's Advanced button opens a diagnostic panel above the playback controls.
It reports prepared future audio, the current preparation stage, recent preparation time, and gaps between sentences.
The panel starts closed each time the reader is activated.
Use **Download debug logs** in this panel after reproducing a problem; the JSON contains up to 500 recent events from the current reader session, including playback state and source-change summaries, but no page text, URLs, or backend tokens. Closing the reader discards the log.

### Experimental iOS Safari build

From `firefox-extension/`, build the shared source and generate an iOS Xcode project:

```bash
npm run build:safari
xcrun safari-web-extension-packager --project-location /tmp/kokoro-safari-xcode --app-name 'Kokoro Reader' --bundle-identifier local.kokoro.reader --swift --ios-only --copy-resources --no-open --no-prompt "$PWD/dist-safari"
```

The generated project is at `/tmp/kokoro-safari-xcode/Kokoro Reader/Kokoro Reader.xcodeproj`. Its copied extension resources are a snapshot: rebuild and regenerate the project when the extension changes. Choose a new project location or deliberately replace the previous generated project; do not overwrite a project with signing changes you need to keep.

To install on an iPhone or iPad:

1. Open the generated project in Xcode and sign in to your Apple Account in Xcode settings. Connect the device by USB, unlock it, and complete the device pairing and trust prompts. If needed, enable **Developer Mode** in the device's Settings > Privacy & Security, restart, and confirm. See Apple's [device running and signing guide](https://developer.apple.com/documentation/xcode/building-and-running-an-app) and [Developer Mode instructions](https://developer.apple.com/documentation/xcode/enabling-developer-mode-on-a-device).
2. In **Signing & Capabilities**, enable **Automatically manage signing** for both the app and extension targets and select the same team. Assign a unique app bundle identifier for your team and an extension identifier prefixed by the app identifier, such as `com.example.kokororeader` and `com.example.kokororeader.Extension`. Check both targets: the generated identifiers can be inconsistent. Let Xcode register the device and provision both targets.
3. Select the connected device as the run destination and choose **Product > Run**. Launch the installed Kokoro Reader app once. On the device, open **Settings > Apps > Safari > Extensions**, enable Kokoro Reader, and grant the requested website access when using the extension. On older iOS versions Safari may appear directly under Settings. Open an ordinary webpage in Safari, invoke Kokoro Reader from Safari's extension controls, and keep the page and screen in the foreground while reading.

A free Xcode Personal Team can install on a personal device, but its provisioning profiles expire seven days after issuance; rebuild and reinstall after expiry. See [Apple's account limits](https://developer.apple.com/help/account/basics/about-your-developer-account). For distribution through TestFlight, enroll in the Apple Developer Program and upload a build to App Store Connect. Each TestFlight build is available for up to 90 days; see [Apple's TestFlight overview](https://developer.apple.com/help/app-store-connect/test-a-beta-version/testflight-overview/). These are separate installation paths, and neither has been validated on a physical device for this project.

**Physical-device backend:** on an iPhone or iPad, `127.0.0.1` points to that device. Use the Mac's LAN IP address or `.local` hostname and start the server with the LAN options above. Safari may require local network and host access permissions; this path has not been verified on a physical device. The simulator can reach a Mac loopback server after granting the local network permission.

The Safari target remains experimental. Its nonpersistent background can lose the in-memory coordinator on suspension, and recovery needs further testing. The Safari build omits the Firefox selection context menu; the reader toolbar still offers selection and whole-page reading.
