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

Implementation has not started yet.
