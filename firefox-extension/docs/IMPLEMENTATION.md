# Firefox reader execution plan

The approved design is in [PLAN.md](PLAN.md).
Implement the five steps below in order, with a subagent report and review before each step is committed.
Use the existing global Git author and run formatting, lint, type checking, unit tests, and the relevant real Firefox checks before each commit.
Each subagent works on its own step branch in an isolated worktree.
The primary agent integrates reviewed commits into the implementation branch.
GitHub issues are disabled for this repository, so no issue can be attached and nothing will be published.

## 1. Extension foundation and Firefox feasibility

- Add a locked TypeScript/esbuild project, MV2 manifest, options page, user-triggered injection, and minimal controls.
- Add a real Firefox/Selenium harness with deterministic page and WAV fixtures.
- Verify installed-extension activation, loopback authentication/fetch, ArrayBuffer messaging, user-gesture playback, and CSS highlights.
- Use the production permissions; do not replace extension loading with page-script injection.
- Establish lint, formatting, type checking, build, web-ext lint, and unit-test commands.
- Report actual Firefox version, feasibility results, and manual-only browser entry points.

## 2. Selection reading and playback lifecycle

- Implement exact selection-to-DOM mapping and sentence segmentation.
- Add bounded WAV requests and a testable playback/session controller with play, pause, resume, stop, retry, and stale-result rejection.
- Keep the backend token in extension settings/background messages, never in page UI or content-script messages.
- Add tests for offsets, decoding errors, cancellation races, pause offsets, audio completion, and request bounds.
- Verify selection reading and controls through the installed extension in Firefox.

## 3. Page extraction and spoken-text highlighting

- Extract visible prose from article/main roots and conservatively use Readability for other pages.
- Preserve source mappings through whitespace normalization, inline elements, repeated phrases, and long-segment splitting.
- Highlight only the segment whose audio is playing and clear only extension-owned marks.
- Add fixture/unit tests and Firefox article/highlight tests.

## 4. Mouse interaction

- Implement explicit click-to-read mode, hover preview, caret/range hit testing, and click-to-seek.
- Preserve normal links, buttons, typing, modified clicks, and text-selection dragging.
- Cancel obsolete audio and generation on seek, including delayed decode results.
- Test event policy in units and real pointer behavior/races in Firefox.

## 5. Lifecycle, integration, and personal-use packaging

- Enforce one reading page and one backend request at a time, with at most one prefetched sentence.
- Handle navigation, document mutation, settings changes, background tabs, server failures, and bounded retries/memory.
- Check the control bar visually at narrow widths, dark/light pages, and zoom; verify keyboard accessibility.
- Run the complete unit/E2E suites and an opt-in real Kokoro smoke test.
- Write installation and use instructions and build an installable development artifact.
- Ask the user for a short listening/normal-browser acceptance test if automation cannot establish speaker output or browser-chrome behavior.

## Reports and review log

### Step 1 report

Implemented the locked TypeScript/esbuild project, production MV2 manifest, validated loopback settings, authenticated bounded WAV transport, persistent background routing, and user-triggered reader controls.
The content script starts an AudioContext from the Play gesture, receives an ArrayBuffer through extension messaging, plays decoded WAV, and marks the speaking range with the CSS Highlight API.
The token stays in extension storage and background/options code.
The page receives no token or settings message.

Validation passed: TypeScript, ESLint, Prettier, 23 Vitest unit tests, esbuild, web-ext with zero errors and warnings, Python Black/Ruff, and one installed-extension E2E test in Firefox 157.0.1 with geckodriver 0.37.1.
The E2E test uses a fresh profile and a deterministic WAV server, saves and checks authenticated settings, clicks the actual browser action through Firefox's Extensions menu, and reads a page outside the backend host permissions.
It proves authenticated WAV fetch, ArrayBuffer messaging, a real audio completion event, the exact speaking highlight, and highlight cleanup.
The primary agent reviewed the playing screenshot and confirmed a visible highlight and legible compact controls.
Failure artifacts include screenshots, sanitized browser control metadata, fixture request history without authorization headers, and the driver log.

The next steps replace the foundation's first-paragraph/selection playback with the planned session controller, extraction, and interactions.
The Alt+Shift+K shortcut and selection context menu remain manual browser checks; headless WebDriver key routing did not reliably activate the shortcut.
Audible speaker output also requires a listening check.
The test-only geckodriver system-access flag permits automation of browser chrome and the extension options page without adding extension permissions.
On macOS the harness isolates application data with `CFFIXED_USER_HOME`, avoiding personal Firefox profiles and Full Disk Access.

### Step 2 report

Implemented exact selection clipping and UTF-16 source mapping, whitespace normalization, inline/block/line-break handling, sentence segmentation, and splitting at 1,000 Unicode code points without truncation.
Selection ranges are cloned before the controls receive focus, and repeated activation can replace the scope while keeping one control bar.
The session and Web Audio modules support sequential playback, exact audio-clock pause offsets, Resume, Stop, completion, Retry at the failed sentence, and cancellation of stale requests, decodes, and end callbacks.
The controls show sentence progress and keep a distinct paused highlight.
Background cancellation matches the originating tab and request ID, and audio/settings requests reject redirects.
The token remains in extension storage and background/options code.
WAV validation checks the backend's 24 kHz mono PCM format and rejects raw plus decoded audio exceeding 32 MiB before decoding, with a second check on the actual buffer size.

Validation passed: TypeScript, ESLint, Prettier, 65 unit tests, build, web-ext with zero errors and warnings, Black, Ruff, and five installed-extension E2E tests in Firefox 157.0.1.
The browser suite exercises all three real entry points, selection across inline nodes and emoji, exact sentence highlights, selection replacement, pause/resume without another request, Stop, delayed-response cancellation, and malformed-WAV Retry.
The foundation browser test exposed that `crypto.randomUUID()` is unavailable on ordinary HTTP pages.
Request IDs now use `crypto.getRandomValues()`, covered by a regression unit test and the passing HTTP-page E2E suite.
The reusable harness records request history and reader state without tokens and captures speaking, paused, and failure screenshots.
The primary agent reviewed the selection screenshot and confirmed that the mapped highlight follows the intended source text.
A focused test isolated slow Firefox shutdown to WebDriver leaving the native context menu open after dispatching its menu item action, even without audio.
The harness now dismisses that popup after the real click and waits for it to close; the focused selection test passed in 7.87 seconds, down from 77.79 seconds.
This is test cleanup only and does not change the extension's permissions or activation path.

Remaining scope for later steps: complete article extraction and fallback highlighting, click-to-read, cross-tab ownership, bounded prefetch/retries, mutation/settings lifecycle, and the real-backend listening check.
Requests remain sequential in this step, and the no-selection fallback still reads only the first article/main paragraph.
The normal page selection can visually overlay its own blue selection color on the sentence highlight; article/highlight polish can improve that presentation without losing the original selection mapping.

### Step 3 report

Implemented visible article/main extraction with ordered source blocks, preserving article headings, lists, quotations, repeated text, and nested block order.
Ambiguous similarly sized article cards offer selection reading instead of silently selecting the first card.
For pages without semantic roots, Mozilla Readability parses a visibility-filtered clone and its retained blocks must have a unique ordered mapping to the live DOM.
The mapping compares earliest and latest possible matches, so surrounding context can disambiguate repeated text without guessing.
The original page nodes and markup are preserved.
Closed details content, hidden elements, controls, editable regions, navigation, and unrelated sidebars are excluded, and shadow-root selections are ignored.

Speaking and paused highlights now include distinct underline decorations while retaining the user's native selection.
A feature-detected outline fallback marks the active block and restores its previous inline outline values and priorities without overwriting subsequent page-owned changes.
Fallback status explicitly says “Block highlight”.
The build includes unchanged Readability and license files, with a narrow web-ext lint exclusion for only the upstream vendor's detached-clone HTML assignments.
Application bundles remain fully linted.

Local validation passed: TypeScript, ESLint, Prettier, 84 unit tests, build, scoped web-ext validation with zero errors and warnings, Black, and Ruff.
Firefox 157.0.1 validation passed all nine scenarios: eight production-bundle cases in the complete run and the focused outline-fallback case in 3.17 seconds.
The cases cover full article ordering, Readability mapping to unchanged live nodes, ambiguous/empty pages, all previous selection/playback behavior, and native selection preservation.
The fallback case uses a separate temporary build that defines `Highlight` as unavailable, because Firefox 157 no longer disables the API through the earlier preference.
It uses the same manifest, permissions, real activation, and fallback implementation, with no page command hook.
The browser checks confirmed the Readability global remains isolated from page scripts and that speaking, paused, and restored outline styles are correct.
The primary agent reviewed article highlights, the underline over native selection, and the coarse fallback outline screenshots.
Unit coverage caught CSSOM color serialization affecting outline restoration, which now compares the browser's serialized applied values.

Remaining scope for later steps: click-to-read, cross-tab ownership, bounded prefetch/retries, mutation/settings lifecycle, and the real-backend listening check.
Readability mappings intentionally reject pages whose extracted blocks cannot be matched confidently; manual selection remains the fallback.

### Step 4 report

Implemented an explicit Click to read toggle with accessible pressed state, low-priority sentence hover preview, and click-to-seek within the current reading scope.
Pointer resolution combines Firefox's caret position with actual source-range rectangles, so nearby whitespace does not select a sentence.
The controller preserves links, native and custom controls, editable text, details summaries, modified and non-left clicks, and text-selection drags.
Hover work is limited to one animation frame and invalidated on scope replacement, scrolling, blur, Escape, Stop, or Close.
Escape exits click mode without changing playback, and Stop clears preview while leaving the explicit mode enabled.
Close removes the pointer/keyboard listeners and extension-owned hover marks.
When CSS highlights are unavailable, seeking remains available with the existing speaking-block outline and no hover preview.

Unit coverage exercises event policy, caret/rectangle targeting, drag detection, stale hover callbacks, highlight ownership, controls, and generation-safe seek transitions from playing or paused audio.
The browser suite adds real wrapped-text pointer targeting, hover/click seeking, Escape, delayed-response seeking to the last sentence, links/buttons/typing/details, actual drag selection, and ignored whitespace/modifiers/right clicks.
Validation passed: TypeScript, ESLint, Prettier, 116 unit tests, build, scoped web-ext validation with zero errors and warnings, Black, Ruff, and all thirteen Firefox 157.0.1 E2E scenarios.
The complete browser run passed twelve cases and exposed a native animation-frame receiver error in hover handling.
The controller now calls `window.requestAnimationFrame` and `window.cancelAnimationFrame` through small wrappers, with a regression unit checking the Window receiver.
All four mouse cases then passed in 18.24 seconds, completing validation of the affected paths and the full scenario set.
The primary agent reviewed the wrapped-sentence hover screenshot and confirmed an exact visible preview, clear toggle state, and unchanged ordinary page controls.

Remaining scope for the final step: cross-tab ownership, bounded prefetch/retries, mutation/settings lifecycle, visual/accessibility review, packaging, and real-backend listening validation.

### Step 5 report

Implemented global reading ownership with a fresh lease for every Play or Resume, including cached audio.
A shared handoff barrier waits for prior pages to acknowledge Stop, even when several claims overlap.
The background waits for an aborted synthesis fetch to settle before starting its replacement and rejects stale leases, requests, and results.
Navigation and tab closure release ownership, while background tabs continue playing.

The session prefetches only one next WAV while current audio plays and does not decode or highlight it early.
The streaming, retained-audio, and decode budgets stay within the logical 32 MiB limit, and native decoding must settle before another response is allocated after cancellation.
Stored fetch and decoder settlement barriers resolve to void so they do not retain successful audio buffers.
A failed prefetch is best-effort: the unread sentence gets its normal request budget when playback reaches it.
HTTP 429 responses receive bounded, abortable Retry-After waits for up to 5 seconds, followed by an actionable Retry state. New generations cancel obsolete waits.
Rejected response bodies are canceled, and settings or network errors remain recoverable.

Source snapshots detect relevant text, node removal, and visibility changes while ignoring the extension's own controls and outline styles.
Changes stop playback with “Page changed”, and Play refreshes the retained article or selection scope.
Toolbar activation with the same retained selection focuses the controls without resetting playback.
Settings updates discard old voice/speed audio and restart the current sentence; paused sessions remain paused until resumed.
A delayed settings notice still invalidates a cached buffer after Resume has claimed a newer lease, while saving identical settings leaves playback alone.
The toolbar action has a native SVG icon, clears its failure badge after successful activation, and explains unsupported Firefox pages in its title.

Unit tests cover ownership races and acknowledgments, serialized cancellation, bounded retries, stale work, prefetch timing and memory, source mutations, settings invalidation, and response cleanup.
The installed-Firefox suite adds deterministic lifecycle, error recovery, background-tab, layout, zoom, and keyboard scenarios while preserving all thirteen earlier scenarios.
The README documents manual server startup, temporary personal installation, feature boundaries, validation commands, and a short audible listening checklist.

Validation passed: TypeScript, ESLint, Prettier, 147 unit tests, build, scoped web-ext with zero errors and warnings, Black, and Ruff.
The final installed-Firefox run passed all 28 cases in 141.96 seconds: 26 deterministic scenarios plus real Kokoro CPU and automatic MPS cases on Apple Silicon.
Both real-backend cases verified the reported device, actual WAV generation, pause/resume, click seeking, completion, and highlight cleanup without a test audio substitute.
Time from Play to first audio was 0.44 seconds on CPU and 1.93 seconds on MPS in these warm local runs; these observations are not benchmarks.
The prior full deterministic pass also completed all 24 cases present before the last settings and narrow-layout additions.

Screenshot review caught uneven page-edge spacing at zoom, so the controls now use symmetric 16-pixel gutters and include a 320 CSS-pixel viewport case.
All five headed Firefox presentation and keyboard checks passed in 17.03 seconds, and the primary agent reviewed the light, dark, and 320 CSS-pixel screenshots.
Packaging produced `firefox-extension/artifacts/kokoro_page_reader-0.1.0.zip`, containing the production bundles, manifest, SVG action icon, unchanged Readability, and licenses.
The artifact is unsigned and intended for Firefox's temporary add-on loader.
The backend implementation is unchanged; its regression suite separately passed 134 tests with three opt-in tests skipped.
Audible speaker output and the user's preferred voice still need the README's manual listening check in a normal Firefox session.

### Follow-up: selection in document editors and conversation pages

The user confirmed article reading works, but reported that selecting text after opening the bar on Notion or ChatGPT still showed “No readable text selected”.
Real mouse-selection tests in Firefox reproduced rejected editable selections, an existing reading scope taking precedence over a newly selected passage, and ambiguous conversation articles preventing main-landmark extraction.
The bar now watches page selections, offers an explicit Read selection action, and retains source ranges when focusing controls causes an editor to clear its native selection.
Selecting text alone does not start or interrupt audio, and the action replaces the scope only when pressed.
Explicit selections permit visible editor and application-sidebar text while automatic extraction still excludes editors, composers, navigation, and controls.
Source watching applies the same selection policy, so editing or hiding selected document text invalidates playback.

A delegated extraction change recognizes ARIA main landmarks and reads multiple article turns inside a single containing main in document order.
Single articles retain preference, and unrelated ambiguous article roots still require a selection.
Review identified a mismatch between selected-sidebar mapping and pointer hit testing; a failing real Firefox hover case reproduced it before the hit test was corrected.
Click mode still leaves editor interaction and ordinary controls alone.

Validation passed: 162 unit tests, TypeScript, ESLint, Prettier, Black, Ruff, build, and scoped web-ext with zero errors or warnings.
The complete deterministic Firefox run passed 34 cases in 162.70 seconds, with the two opt-in real-backend tests skipped because the audio transport and backend were unchanged.
After the pointer-policy correction, all thirteen headed web-app and mouse cases passed in 65.62 seconds, covering the additional sidebar regression and completing validation of 35 distinct deterministic Firefox scenarios.
The primary agent reviewed screenshots showing the Read selection prompt before playback and exact highlighting of editable text during playback.
Backend code and the audio transport were unchanged.
The extension was rebuilt in `dist/` and its temporary-install ZIP was regenerated.
The user was asked to reload the extension and page, then retry the original workflow on their actual Notion or ChatGPT page; the automated reproductions use local document and conversation fixtures.

### Follow-up: click-to-read in editable documents and web apps

The user confirmed selection reading now works and that click-to-read works on articles but not ChatGPT or Notion.
They explicitly approved temporarily taking over editable document text clicks while click mode is enabled.
Three real Firefox failures reproduced focusable conversation containers being rejected, a newly selected editor passage not being adopted by the mode, and an unselected editable document having no clickable scope.

A delegated pointer change replaced generic focusability, delegated-handler, draggable, and editor exclusions with concrete native and ARIA control exclusions.
The pointer controller accepts a synchronous scope resolver, so hovering can preview a document without choosing it for playback and clicking can start within that document using the original user activation.
Enabling the mode now prepares a pending selection without requiring Play or Read selection first.
Selected passages remain strict reading boundaries.
Editable documents use their nearest document, article, or main landmark, falling back to the editor itself, and retain original DOM ranges across blocks.
Automatic page extraction continues to exclude editable text and composers until the user explicitly chooses them.
One editor preview is cached and watched for text or visibility changes, then cleared on replacement, mode exit, or Close.

The bar shows a click-mode instruction and Escape hint, plus an actionable message for an eligible click outside readable text.
A browser regression caught hover resolution clearing that message too early; feedback now clears only when readable text is actually found.
Native editor links are verified by checking that their click reaches the page unprevented, since Firefox normally treats a link inside contenteditable as an editing click rather than navigation.
Escape and disabling the mode restore ordinary editor clicks without changing contenteditable attributes or rewriting the page.

Unit coverage includes targeting policy, transient scopes, feedback, document mapping, and full-document mutation watching.
Real pointer cases cover starting without Play, pending selections, passive hover during playback, editor preview invalidation, playback recovery after an edit, selection boundaries, controls, drag selection, and editing after Escape.
Validation passed: 179 unit tests, TypeScript, ESLint, Prettier, Black, Ruff, build, and scoped web-ext with zero errors and warnings.
The final Firefox suite passed all 43 cases in 232.62 seconds, including real Kokoro CPU and MPS playback, with no skipped tests.
All eleven headed click-mode, keyboard, and presentation cases passed in 52.68 seconds, and the primary agent reviewed the editable-sentence hover and mode-instruction screenshot.
The development build and temporary-install ZIP were regenerated for the user to retry on their actual Notion and ChatGPT pages.

### Follow-up: short-sentence preparation gaps

The user confirmed the web-app click behavior and requested merging to main, then reported gaps with “Preparing next” between short Reddit sentences.
The accepted web-app work was fast-forwarded into local main before starting this follow-up on a separate branch.
The [performance plan and measurements](PERFORMANCE.md) record the reproduction, implementation steps, and device comparison.

An installed-Firefox regression reproduced a 981 ms preparation stall before production code changed.
The one-sentence prefetch left the server idle during earlier playback and deferred decoding until the sentence transition.
A delegated implementation now fills a queue with serially fetched and decoded future sentences, targeting 15 seconds and stopping at eight future sentences or the existing 32 MiB logical memory cap.
The first sentence starts immediately; later ready buffers start synchronously when the current clip ends, without premature highlighting or a Preparing transition.
Failed prefetch remains best-effort and gets one foreground retry, and cancellation, pause, seek, settings, and ownership changes discard obsolete queued audio.
Review also added protection for a playback-start exception during the new synchronous transition.

All 195 unit tests passed, including 16 new regressions for buffering, bounds, lifecycle, and errors.
The full installed-Firefox suite passed all 47 cases in 287.56 seconds, including real CPU and automatic Apple Silicon MPS playback, with no skips.
The original deterministic reproduction now has no Preparing interval between sentences; its third Playing transition was 3 ms beyond the preceding clip's expected end, versus 984 ms before the fix.
Both real-model eight-sentence runs also had no observed Preparing intervals between sentences, compared with baseline totals of 45 ms on CPU and 731 ms on MPS.
These are local UI/playback timing observations, not measurements of audible silence inside Kokoro's waveform.
The two focused buffering cases also passed in headed Firefox in 15.02 seconds after adding a cadence assertion, with a 4 ms transition delay in that repeat.

TypeScript, ESLint, Prettier, Black, Ruff, production build, and scoped web-ext validation passed.
The development build and temporary-install ZIP were regenerated, and the user was asked to reload the add-on and Reddit page for a listening check.
The server retains one worker, one active synthesis job, and automatic MPS selection; extra HTTP workers would not improve this serial client by themselves.

### Advanced diagnostics prototype

The optional panel reports decoded future audio and a bounded view of the current and upcoming sentences.
Preparation time covers waiting for any prior decode, the server request, and decoding; it is not a measurement of model inference.
An underrun begins when playback reaches an unprepared next sentence and ends when that sentence starts.
Startup, seeks, and resumes do not start an underrun.
A gap interrupted by pause or error records the elapsed wait, and stop resets the statistics.
The panel updates elapsed time only while open, and its expansion preference is held in extension storage.
The panel can download a bounded in-memory session log of playback transitions and source invalidation reasons and mutation counts; it excludes source text, URLs, and tokens.

Validation: 202 unit tests passed, and both advanced-panel tests passed in headed Firefox.
The full Firefox suite passed all 49 cases, including real CPU and MPS coverage.

## Source and UI refactor

The [execution plan](REFACTOR_PLAN.md) splits layout, styles, renderer evaluation, and browser wiring into reviewable changes.
The source tree separates UI, reading, speech, and icon assets while keeping the same manifest and installed script paths.
The build packages the options stylesheet and bundles toolbar and highlight CSS as text for their existing style elements.
Toolbar placement and the page-owned outline fallback retain their inline styles.
The runtime speech adapter owns content-to-background request, ownership, and cancellation messages.
Click targeting takes the actual toolbar host, which removes its dependency on the UI module.
Page, selection, and editor-preview lifecycle stay coordinated in the content entry point.

Firefox 157.0.1 passed 46 installed-extension tests for the renderer-preserving refactor, including the new connection test. The four opt-in real-backend cases were skipped for this run.
The original extension passed 45 deterministic cases, with the same four skips. A focused baseline comparison under restrictive page CSP observed matching toolbar styles, highlight registration, and cleanup.
The final branch passed 202 Vitest tests, TypeScript, ESLint, Prettier, Black, Ruff, and a clean build, extension lint, and package.

The Svelte migration renders the settings form and the shadow-root controls with Svelte.
The controls adapter preserves synchronous updates and focus for the existing content entry point.
The build compiles DOM-tree fragments to keep extension lint clean and packages licenses for the bundled runtime.
The installed settings test verifies the voice list and token error through the real extension page.

Firefox 157.0.1 passed all 50 installed-extension cases before the final diagnostics update, including four real Kokoro CPU and automatic MPS cases.
All four headless toolbar layout screenshots matched baseline byte-for-byte.
Seven focused headed Firefox presentation, keyboard, and diagnostics cases passed after the update. The final candidate passed 203 unit tests, TypeScript and Svelte checking, ESLint, Prettier, Black, Ruff, build, extension lint, and packaging.

With `gzip -cn`, the renderer-preserving build's content and options scripts measured 15,483 and 1,328 bytes. The final Svelte build measured 54,927 and 40,408 bytes, respectively. The unsigned ZIP grew from 53,442 to 133,196 bytes.

### Title abbreviation sentence boundaries

Sentence mapping now joins Intl.Segmenter boundaries after Mr., Mrs., Ms., Dr.,
and Prof. when followed by an uppercase letter. It merges original offsets before
applying the existing length limit, preserving DOM ranges and highlighting.
Regression coverage includes titles, repeated titles across inline elements and
emoji, ordinary sentence boundaries, and U.S. followed by lowercase prose.
All 210 unit tests, type checking, ESLint, and the production build passed.

### Source replacement during playback

For automatically extracted pages, the source watcher can rebind sentence ranges after a same-text DOM replacement without restarting playback. It verifies the complete readable node sequence, exact text (including whitespace), ancestor tag paths and block grouping before rebuilding ranges from offsets saved before the mutation. Selection and editor scopes remain conservative and invalidate on replacement. Changed text, visibility, disconnected roots, or mappings that cannot be verified still invalidate the session.

## Available voice selection

The settings page loads available voices after restoring saved credentials and refreshes them on Test connection. Selecting a voice fills the editable voice field; failed or empty discovery leaves manual entry available. Credential edits invalidate pending discovery results.
