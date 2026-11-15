# Reducing pauses between sentences

## Goal

Keep short replies flowing when one later sentence takes longer to synthesize than the sentence immediately before it takes to play.
Preserve sentence highlighting, immediate first playback, cancellation, and the OpenAI-style WAV endpoint.

## Implementation steps

1. Reproduce the reported “Preparing next” pause in the installed Firefox extension and measure real CPU/MPS playback before changing production code.
2. Replace one-sentence raw-WAV prefetch with serial fetch and decode into a small future-audio queue.
   Stop filling when the queue reaches 15 seconds of decoded future audio or eight future sentences, whichever comes first.
   A final sentence may cross the duration target because its duration is known only after synthesis.
   Keep the combined logical raw, assembly, current, and queued decoded audio budget within 32 MiB.
   Start the first sentence immediately and consume ready sentences without entering Preparing.
3. Verify queue refill, bounds, cancellation, errors, and highlighting with unit tests, then run the installed Firefox regression suite and real CPU/MPS speech tests.
   Rebuild the temporary add-on and ask for a listening check on the reported Reddit page.

The queue implementation is delegated in an isolated worktree; browser reproduction, integration, review, and real-device validation are handled by the primary agent.
The repository's GitHub issue tracker is disabled, so this work uses a dedicated local branch without an issue number.

## Findings before the change

The server has one Uvicorn process and one dedicated synthesis thread with one active job.
PyTorch uses internal parallelism; the installed Torch 2.6.0 runtime reported four intra-operation CPU threads.
The extension also serializes its requests, so increasing HTTP worker count alone would not let it prepare sentences earlier.
Multiple server processes would each load a model, and their effect on GPU throughput would need a separate benchmark.

The previous session fetched only the next WAV during playback, then decoded that WAV after the current sentence ended.
Even when there was plenty of earlier playback time available, it waited for the next sentence to start before requesting the one after that.
The installed-Firefox regression uses a four-second first clip, a 0.3-second second clip, and a third response delayed by 1.2 seconds.
It reproduced a 981 ms Preparing gap on the third sentence before any production changes.

An eight-sentence conversation fixture also exercised the actual cached model through HTTP and Firefox playback.
Before the change, observed Preparing intervals after playback began totaled 45 ms on CPU and 731 ms on automatic MPS, with a maximum MPS interval of 242 ms.
These are UI preparation intervals, not measurements of speaker silence or pauses embedded in the generated waveform.

Separate direct engine probes used the production single-thread execution pattern, `af_heart`, speed 1, cached assets, and the ordinary startup warm-up.
The three inputs contained 32, 131, and 239 characters and produced 2.475, 7.475, and 13.975 seconds of audio respectively.

| Input length | CPU first request for text | MPS first request for text | CPU repeat mean | MPS repeat mean |
| --- | ---: | ---: | ---: | ---: |
| 32 characters | 0.289 s | 1.095 s | 0.267 s | 0.235 s |
| 131 characters | 0.820 s | 2.861 s | 0.761 s | 0.644 s |
| 239 characters | 1.504 s | 2.140 s | 1.435 s | 1.182 s |

Each measured sentence produced one model chunk, so switching those same requests to PCM would not expose audio before that model operation completed.
Two and eight CPU threads did not show a consistent advantage over the current default of four.
An inference-mode experiment did not improve warmed request times consistently enough to justify a production change.
The first-request differences suggest that MPS preparation for unfamiliar shapes can contribute to short-sentence stalls; these small local probes do not establish a general device ranking.
Automatic MPS selection remains enabled as requested.
For a direct device comparison on a particular page, restart the same server with `python -m kokoro_server --device cpu` and keep its token, voice, and reading speed unchanged.

## Reproduce the playback checks

Build the extension first, then run the deterministic regression:

```bash
cd firefox-extension
npm run build
cd ..
.venv/bin/python -m pytest firefox-extension/tests/e2e/test_buffering.py -q
```

Run real CPU and automatic MPS playback with cached model/language resources, Firefox, geckodriver, and GPU access:

```bash
KOKORO_TEST_REAL_EXTENSION=1 .venv/bin/python -m pytest \
  firefox-extension/tests/e2e/test_real_server.py -k short_replies -q -s
```

The tests record public control-state transitions in each test artifact directory without modifying the extension or replacing its real audio player.
The deterministic regression bounds Preparing stalls; the real-model probe checks sentence order and completion and reports timing without imposing a hardware-specific speed requirement.

## Validation after the change

The deterministic Firefox reproduction advanced through all three sentences without entering Preparing between them, eliminating the previously measured 981 ms preparation stall.
The public UI trace kept the speaking highlight on each sentence until its audio completed.
The malformed-prefetch browser case also verified that a decode failure leaves current playback alone and retries the unread sentence when it is needed.
The third sentence's Playing transition occurred 984 ms after the preceding clip's expected end before the fix and 3 ms after it in the full post-change browser run.
This additional cadence check prevents the regression test from passing merely because a Preparing indicator was hidden.

With the actual model, both CPU and automatic MPS completed all eight short replies with zero observed Preparing intervals between sentences.
The baseline totals were 45 ms and 731 ms respectively.
This remains a small local playback comparison, not a guarantee of gapless speaker output under arbitrary load.

The delegated implementation added 16 unit regressions, bringing the complete unit suite to 195 passing cases.
These cover serial fill/refill, duration/count/memory limits, immediate ready transitions, waiting for an unfinished request or decode, foreground retries, stale work, pause/resume, seek, settings changes, and playback-start exceptions.
The complete installed-Firefox suite passed all 47 cases in 287.56 seconds, including real CPU and automatic MPS tests, with no skips.
Both focused buffering cases passed again in headed Firefox after strengthening the cadence assertion; the third transition was 4 ms beyond the preceding clip's expected end.
TypeScript, ESLint, Prettier, Black, Ruff, build, and scoped web-ext validation passed, and the temporary-install ZIP was rebuilt.
