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
