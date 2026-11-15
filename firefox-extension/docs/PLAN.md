# Minimal Firefox page reader

Draft for review, November 14, 2026.
This document plans the extension; it does not implement or install it.
It builds on the working local server described in [server guide](../../kokoro_server/README.md).

## First usable version

Open a normal webpage, activate Kokoro, and press Play to hear its main content while the current sentence is highlighted in the original page.
Enable “Click to read” to start at a different sentence with the mouse.
Pause, resume, stop, and selection reading should work predictably without a sidebar, library, or separate player tab.

Use the existing backend without changing its API.
Sentence-level highlighting is the initial contract: the server returns audio but no word timestamps.
Do not approximate word timing by dividing the sentence duration evenly across words.
Accurate word highlighting would require a separate backend timing feature and validation later.

This refines [the earlier exploration](../../TTS_EXTENSION_PLAN.md) around a smaller UI and page-scoped playback.
Navigating or closing the source page stops reading; switching to another tab does not.
Only one page may read at a time.

## Minimal interaction design

Place a compact, fixed control bar at the lower-right of the page, with styles isolated in a Shadow DOM.
Do not inject it until the user activates the extension.
Keep it keyboard accessible, within the viewport at high zoom, and clear of the text where possible.

```text
Kokoro   [Play / Pause] [Stop] [Click to read] [Settings] [Close]
Sentence 3 of 24 · Playing
```

| Action | Defined behavior |
| --- | --- |
| Toolbar button or extension shortcut | Show or focus the control bar; extract content and show Ready. |
| Play | Resume a paused sentence or start from the selected reading position. |
| Pause | Stop the audio clock and retain the exact offset and current sentence. |
| Stop | Cancel requests, discard pending audio, clear highlights, and reset to the beginning of the selected reading scope. |
| Click to read | Toggle an explicit selection mode; hover previews a readable sentence, and clicking it starts reading there through the end of the article. |
| Escape | Exit click mode and clear its hover preview; do not also stop ordinary playback. |
| Read selection context menu | Restrict the reading scope to the selection and preserve its original DOM ranges. |
| Close | Stop playback and remove controls, highlights, and listeners. |
| Settings | Open a small extension options page for backend URL, token, voice, and synthesis speed. |

Ordinary clicks retain normal behavior outside click mode.
Even in click mode, never hijack links, buttons, inputs, editable regions, modified clicks, middle/right clicks, or text-selection drags.
Use the sentence under the pointer only after confirming it belongs to the extracted reading scope.
Do not turn page text into thousands of clickable wrapper elements.

Keep voice and speed in Settings initially to reduce clutter.
Changing either stops pending work and restarts the current sentence with the new setting.
Use the backend's synthesis speed only; browser playback stays at 1x.
Do not auto-scroll initially: the highlight follows reading while the user controls scrolling.

Show Ready, Preparing, Playing, Paused, Finished, and a short actionable Error state.
Distinguish an unavailable server, wrong token, busy server, and empty extraction.
After a playback error, retain the reading position and offer Retry for that sentence.
Do not place connection details or tokens in the page control bar.

## Technology and execution contexts

Recommended stack: TypeScript, plain HTML/CSS, esbuild, and Firefox's native `browser` APIs.
Use Vitest with jsdom for unit tests, ESLint/Prettier/type checking for code quality, and `web-ext` for extension validation, development loading, and packaging.
Keep dependencies locked inside this directory; no frontend framework is needed for this control bar.

For this personal Firefox-only tool, propose **Manifest V2 with a persistent background script** for the first version.
This avoids both a permanent player tab and an event-page lifecycle workaround.
Firefox documents persistent background pages for MV2; MV3 background pages are nonpersistent.
Verify the installed Firefox release accepts the manifest during the first implementation step, and record the tested version rather than assuming indefinite support.
[Firefox background manifest](https://developer.mozilla.org/en-US/docs/Mozilla/Add-ons/WebExtensions/manifest.json/background)

This is a deliberate change from the earlier MV3/player-tab proposal.
Keep the transport and session logic modular so it can move into an MV3 extension page later if needed.
Do not rely on a permanently open message port to keep an MV3 background alive.
[Background lifecycle](https://developer.mozilla.org/en-US/docs/Mozilla/Add-ons/WebExtensions/Background_scripts)

| Context | Responsibility |
| --- | --- |
| Persistent background | Store settings, attach to the active tab, validate messages, own backend requests, and arbitrate the single reading session. |
| Content script | Extract and map text, render controls/highlights, handle mouse gestures, decode audio, and own page-scoped playback. |
| Options page | Configure local server/token/voice/speed, test connection, and display available voices. |

Use `activeTab`, `storage`, and `menus`, plus a narrowly scoped loopback host permission.
Use MV2's `tabs.executeScript` for user-triggered injection and an idempotent initialization guard.
Do not request access to every website.
The extension background makes authenticated requests to the backend; page scripts never receive the token, and no page-to-extension `window.postMessage` bridge is needed.
Validate the sender's tab/frame, message shape, session ID, and requested operation.
Only the configured loopback base URL may receive requests; messages cannot supply arbitrary fetch URLs.

Default to `http://127.0.0.1:8880` and `af_heart`.
Allow a different loopback port in Settings; validate it against the backend's supported loopback hosts.
Use local storage, not synced storage, and render untrusted page text with text APIs.
Do not persist article text or generated audio in this version.

## Text extraction and source mapping

The important output is not just a string: it is readable text with a reliable mapping back to the original DOM.
Represent it as ordered blocks and sentences:

```text
ReadingDocument: document ID, source tab, scope, blocks
Block: ID, text, source text-node spans
Sentence: ID, spoken text, ordered source ranges, block ID
Session: generation ID, document ID, sentence index, playback offset, state
```

Start extraction with visible prose inside a suitable `article`, then `main`, preserving headings, paragraphs, lists, and block quotes.
Use a text-node walker that excludes scripts, styles, navigation, controls, editable content, hidden content, and the extension UI.
Avoid a blind `document.body.innerText` fallback that reads the entire navigation and footer.
Reject ambiguous or empty extraction and suggest selecting a passage instead.

Evaluate bundled Mozilla Readability for pages with weak semantic structure in the article milestone.
Run it on a clone because it modifies its input document.
Map retained blocks back to the live DOM through ordered normalized-text matches with surrounding context; repeated text must not silently map to the first occurrence.
Only accept a mapping when unambiguous; otherwise offer selection reading instead of highlighting the wrong text.
Do not assume Readability preserves custom IDs or source offsets.
[Mozilla Readability](https://github.com/mozilla/readability)

Maintain a mapping from normalized text offsets to original text nodes while collapsing whitespace and joining inline elements.
Use JavaScript UTF-16 offsets consistently for DOM ranges, and test surrogate pairs and combining marks.
Use `Intl.Segmenter` for sentence boundaries and retain punctuation.
Split unusually long sentences at clause/whitespace boundaries, targeting at most 1,000 Unicode code points per request and always below the backend's 4,096-character limit.
Each resulting spoken segment must retain its own source ranges; do not silently truncate text.

Read selection using cloned selection ranges before the control bar receives focus.
Intersect selected ranges with readable text nodes, so the extension does not include text before or after the actual selection.
Support the top-level document first; PDF viewers, browser-internal pages, cross-origin frames, closed shadow roots, and canvas-based editors are outside this version.

## Highlighting and mouse targeting

Use the CSS Custom Highlight API with namespaced highlights for “speaking” and “hover preview.”
It styles DOM ranges without restructuring the page.
Feature-detect `CSS.highlights` and `Highlight`; the compatibility spike must validate them from a Firefox content script.
If unavailable, outline the current block as a clearly described fallback rather than changing the user's selection.
Delete only this extension's highlights during cleanup.
[CSS Custom Highlight API](https://developer.mozilla.org/en-US/docs/Web/API/CSS_Custom_Highlight_API)

Resolve pointer coordinates to a text node and offset with `document.caretPositionFromPoint`, then look up the sentence containing that position.
Confirm the pointer intersects the sentence's actual text rectangles so clicks in nearby whitespace do not select unrelated text.
Throttle hover work to animation frames.
[Caret position from a point](https://developer.mozilla.org/en-US/docs/Web/API/Document/caretPositionFromPoint)

Highlight a sentence when its audio actually starts playing, not when its request is sent or completes.
Keep the paused sentence highlighted with a distinct paused state; clear it on Stop, Close, and completion.
Use the audio clock to schedule transitions, not a timer based on text length.
If a background tab throttles painting, redraw the current correct highlight on visibility change without delaying audio progression.

Observe mutations within the chosen reading root, filtering out the extension's own UI.
If source text changes or mapped nodes disappear, stop and show “Page changed; press Play to refresh.”
Do not attempt automatic remapping while speech is still playing in the first version.
Stop and clean up on document navigation, tab closure, or a new session in another tab.

## Audio and the existing server

Use **one complete WAV request per sentence/segment initially**, with at most one sentence prefetched while another plays.
The later [short-sentence performance follow-up](PERFORMANCE.md) replaces the single future sentence with a bounded, serially prepared queue while retaining this per-sentence API.
This reuses the server as implemented and makes sentence/audio boundaries explicit.
It sacrifices within-sentence streaming to simplify decoding, seeking, and highlighting; test first-audio latency before adding PCM transport complexity.
`decodeAudioData()` expects complete audio-file data, so do not pass it arbitrary network fragments.
[Web Audio decoding](https://developer.mozilla.org/en-US/docs/Web/API/BaseAudioContext/decodeAudioData)

Fetch audio in the background context and send bounded ArrayBuffers through extension messaging.
Firefox's messaging uses structured cloning; verify the binary round trip during the first spike.
Keep raw bytes and decoded audio under a combined memory cap, initially 32 MiB, evicting played/prefetched audio when superseded.
[Firefox message cloning](https://developer.mozilla.org/en-US/docs/Mozilla/Add-ons/WebExtensions/Chrome_incompatibilities#data_cloning_algorithm)

Resume/create the content script's AudioContext directly in the Play or click-to-read user gesture.
If a context-menu action does not permit autoplay, show the control bar and request one explicit Play click.
Track start time and offset for pause/resume, and account for the one-shot nature of AudioBufferSourceNode when seeking or restarting.
Release buffers and audio nodes on Stop or Close.

The background permits only one in-flight synthesis request globally, matching the server's single active job.
Do not request multiple prefetched sentences concurrently.
Every request and playback callback carries a generation ID; seek, stop, setting changes, or a new reading scope invalidate older work immediately.
Abort obsolete fetches and discard all late responses, including late decode completions.
After abort, the backend may still be finishing an operation: honor `429` and `Retry-After` with a small bounded retry window, then show Busy with a Retry control.
Never retry an obsolete generation, and do not replay partially heard speech automatically.

## Unit and component tests

Keep parsing, segmentation, state transitions, and request scheduling independent of Firefox globals.
Inject small browser, transport, and audio-clock adapters so tests use controlled fakes.
Avoid mocking the entire browser or testing only that methods were called.

| Area | Important behavioral tests |
| --- | --- |
| Extraction | Article/main precedence, exclusion rules, nested inline text, headings/lists, whitespace, empty pages, Readability ambiguity, and preservation of the original DOM. |
| Offset mapping | Selections spanning elements, repeated phrases, emoji, combining marks, leading/trailing spaces, and long-sentence splitting reconstruct the exact intended text. |
| State machine | Play/pause/resume/stop/end/error; click seek while preparing/playing/paused; new tab ownership; navigation and mutation cleanup. |
| Transport | Correct URL/auth/schema, one active fetch, one prefetch maximum, limits, abort, delayed replies, failed WAV decoding, 401/429/500, bounded retries, and no stale response adoption. |
| Audio adapter | Exact pause offset, recreated source on resume, correct scheduling order, cancellation of scheduled nodes, final completion, and buffer eviction. |
| UI/event policy | Toggle labels/state, keyboard access, ignored interactive targets, ignored modifier/right clicks and selection drags, click-mode exit, and duplicate initialization. |
| Settings/security | Loopback-only URL validation, token never included in page messages, unknown messages rejected, settings changes invalidating pending work. |

Use fake clocks for races and retry behavior; deliberately resolve cancelled work late.
jsdom does not model layout, real CSS highlights, audio output, user activation, or Firefox extension lifecycle reliably.
Those require the browser tests below.

## Firefox end-to-end tests

Use **pytest + Selenium + geckodriver with actual Firefox**, reusing the repo's Python test environment for backend fixtures.
Install the packaged extension temporarily with Selenium's Firefox `install_addon(..., temporary=True)` support in a fresh profile.
Do not use a personal browser profile.
[Selenium Firefox support](https://www.selenium.dev/documentation/webdriver/browsers/firefox/)

Playwright's documented extension workflow is Chromium-specific; a Playwright Firefox webpage test is not evidence that a Firefox extension works.
[Playwright extension limitations](https://playwright.dev/docs/chrome-extensions)

Serve deterministic HTML fixtures and a fake speech server over loopback.
The fake server should implement our real auth/request contract, record requested text and concurrency, and return short valid WAV tones with known durations.
Provide gates for delayed responses, 429, failures, and disconnected requests.
Test against the production extension bundle with ordinary permissions and the real Web Audio path.
No test should substitute direct content-script injection for loading the extension.

Drive activation through the extension command shortcut and controls using WebDriver actions; establish reliable shortcut activation and `activeTab` permission in the first spike.
If toolbar/context-menu chrome cannot be controlled reliably with WebDriver on the test platform, retain a documented headed manual test for those entry points rather than adding privileged test permissions.
Use the options UI to configure the fixture server and token.
An installation options tab can also provide a stable automated settings entry point.

| E2E scenario | Assertions |
| --- | --- |
| Read article | Requests contain prose in order and omit navigation; control bar enters Playing; the actual source sentence is highlighted. |
| Selection | Only selected text is requested, including selections crossing inline nodes; source ranges match exactly. |
| Click seek | Hover marks the intended sentence; click starts there; old audio is stopped and delayed old responses never resume it. |
| Normal page use | Links navigate, buttons work, typing and drag-selection still work, and disabled click mode does not intercept clicks. |
| Pause/resume/stop | Position remains stable while paused, resumes without repeating the sentence start, and Stop prevents subsequent playback/request progression. |
| Timing | Known WAV durations drive the highlight transition; no highlight advances merely because the next response arrives. |
| Navigation/lifecycle | Background-tab reading continues; source navigation/closure stops it; a new reading tab cancels the old one; reinjection does not duplicate controls. |
| Errors/races | Server unavailable, bad token, 429 after cancellation, malformed WAV, slow responses, rapid repeated clicks, and settings changes produce recoverable states. |
| DOM changes | Removing/replacing a mapped node stops reading and clears stale highlights without changing unrelated page markup. |
| Presentation | Headed screenshots at narrow/wide widths, light/dark pages, and high zoom show legible controls and highlights without obscuring most of the article. |

Use real pointer coordinates against text spanning multiple inline elements to exercise hit testing.
Assert highlight range contents and inspect screenshots of rendered highlights; DOM state alone does not prove they are visible.
For playback, verify actual audio scheduling/current-time progression and decoded sample content through a narrowly scoped read-only diagnostic adapter in test builds if necessary.
Do not claim those checks prove audible speaker output: include a short manual listening check with the real backend.
Never export tokens, article data, or privileged command controls through a test hook into the webpage.

Use explicit waits for states and fixture gates, not long fixed sleeps.
On failure, save screenshots, extension/browser logs, fake-server request history without tokens, and the current session/segment IDs.
Run deterministic E2E tests serially against the single-job server contract.

Add an opt-in smoke run using the real Kokoro server: read a short article, pause, click a later sentence, and finish.
Exercise automatic MPS selection on this Mac and CPU override separately, without placing model downloads in the default extension test suite.
Manually verify speech quality, speaker output, focus behavior, and the three browser-chrome entry points.

## Implementation sequence

1. **Firefox feasibility spike:** manifest, options, toolbar/shortcut activation, user-gesture audio, loopback fetch, binary messaging, and actual CSS highlighting on one fixture page.
   Record Firefox version, required permissions, and autoplay behavior.
   Gate further work on a real installed-extension test, not a web-only demo.
2. **Selection reader:** bounded WAV transport, session state, minimal control bar, pause/resume/stop, and exact selection ranges.
   Add unit tests and a full selection-to-audio Firefox test.
3. **Page extraction:** semantic article roots, sentence mapping, long-segment handling, Readability fallback, and sentence highlighting.
   Add fixture-based extraction tests and article E2E coverage.
4. **Mouse interaction:** explicit click mode, hover preview, accurate hit testing, safe ignored targets, and cancellation on seek.
   Test races with delayed fake-server responses and real mouse coordinates.
5. **Lifecycle and polish:** cross-tab ownership, mutation/navigation cleanup, settings, errors, bounded prefetch, visual/accessibility checks, and real Kokoro smoke tests.
   Record limitations and provide personal-use installation instructions.

For each implementation step, report files changed, tests run/results, and remaining limitations before committing.
Run TypeScript checking, ESLint, Prettier, unit tests, and the relevant Firefox E2E cases; use `web-ext lint` on the built extension.
Run Black and Ruff on any Python test helpers before committing.
[web-ext workflow](https://extensionworkshop.com/documentation/develop/getting-started-with-web-ext/)

Proposed directory layout:

```text
firefox-extension/
  PLAN.md
  README.md
  package.json / package-lock.json
  manifest.json
  src/
    background.ts
    content.ts
    extraction.ts
    mapping.ts
    session.ts
    audio.ts
    highlighting.ts
    controls.ts
    options.ts / options.html
    styles/
  tests/
    unit/
    fixtures/
    e2e/                 # pytest + Selenium and fake-server helpers
  dist/                  # generated extension bundle, ignored by Git
```

The first release is complete when it can read a normal article and an explicit selection, visibly track the spoken sentence, seek by click without stale audio, preserve ordinary page interaction, and pass deterministic Firefox tests plus a real-backend listening smoke test.
Word-level timestamps, continuous PCM streaming, saved progress, PDF/OCR support, cross-browser support, and extension-store publication remain later work.

Workflow note: issue tracking is disabled on `kwsp/kokoro`, verified during planning.
Do not enable it or publish anything as part of this local plan.
Implementation should use a dedicated feature branch and the existing global Git author.
