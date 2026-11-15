# Firefox extension refactor execution plan

Preserve the behavior of the installed extension while making UI markup, styling, and browser integration easier to maintain. Keep each step independently reviewable and revertible.

## 1. Establish a baseline and reorganize source

- Record the baseline unit, build, package lint, and deterministic Firefox results. Run browser tests serially in the harness's isolated profile and record any existing failures or opt-in skips.
- Keep `content.ts`, `background.ts`, and settings validation discoverable at the top of `src/`. Group controls and options in `src/ui/`, DOM reading and highlighting in `src/reading/`, playback and speech coordination in `src/speech/`, and the icon in `src/assets/`.
- Update imports, unit test imports, build inputs, and the contributor code map. Preserve manifest paths, the root output filenames, Readability injection order and licenses, and the isolated highlight-fallback build.
- Verify the packaged files, unit tests, and the installed Firefox activation and highlight-fallback paths before proceeding.

## 2. Extract static styles

- Link a packaged `options.css` from the options page. Bundle toolbar and highlight CSS as text and apply it to the existing shadow root and page, respectively, with the current ownership and cleanup.
- Retain the inline host placement/reset declarations and the conditional outline fallback values. Their cascade and restoration are part of current behavior.
- Verify options rendering, keyboard focus, the toolbar in narrow and zoomed light/dark pages, stylesheet cleanup after close and reopen, and exact range and fallback behavior. Compare the toolbar and highlights on a page with restrictive CSP against baseline.

## 3. Pilot Svelte on the options page

- Keep `options.html` and the existing esbuild entry point. Compile one local settings component and wire its checking, tests, linting, and formatting into the existing commands.
- Preserve the inputs, selectors, native validation, saved settings schema, status announcements, connection request semantics, and voice choices. Exercise the installed options page against the local fixture, including a successful Test connection and a rejected token.
- Review the actual reduction in imperative DOM code, dependency and build changes, emitted bundle size, and browser parity. Proceed to the toolbar if the gain justifies the cost. If the evidence is mixed, present the pilot and ask for review at this checkpoint.

## 4. Migrate the floating controls

- Keep the `createControls()` interface and open shadow root. Feed the Svelte component playback snapshots and action callbacks. Keep the existing selectors, status text, accessibility state, and focus behavior.
- Use a small diagnostics component. Preserve the Advanced preference and its load-versus-user-click ordering, the elapsed timer and cleanup, and the panel's scroll position during updates.
- Verify synchronous focus on activation, correct actions after rapid state updates, no redundant playback attribute mutations, and intact page selection and click-to-read interactions. Run the existing controls, presentation, selection, mouse, click-app, and lifecycle tests.

## 5. Simplify browser integration

- Extract the runtime-message implementation of `SpeechTransport` from `content.ts`. Preserve all message shapes, routing checks, errors, cancellation, and lease semantics.
- Pass the toolbar host into click targeting to remove its dependency on the UI module. Extract reading-source lifecycle only if page, selection, and editor-preview ownership can be made clearer with one small interface and existing behavior tests.
- Verify stop, seek, reactivation, navigation, cross-tab ownership, source replacement, settings changes, and buffering in real Firefox. Run the opt-in real-backend cases if the change affects actual synthesis or playback.

## Integration and final verification

Assign each step to a GPT-6.1 Terra subagent in an isolated branch and worktree. Review the diff and checks before integrating each logical commit on the dedicated refactor branch. Preserve unrelated workspace changes.

Run type checking, lint, formatting, unit tests, a clean build, package lint and packaging, and the deterministic installed Firefox suite on the integrated result. Run Black and Ruff as required by the contributor workflow. Update implementation and contributor documentation for the final layout and build. Record verified results and any gaps before requesting review.
