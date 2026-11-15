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
