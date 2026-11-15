<script lang="ts">
  import type { Snapshot } from "../speech/session";
  let { snapshot, now }: { snapshot: Snapshot; now: number } = $props();
  let d = $derived(snapshot.diagnostics);
  let gapMs = $derived(d?.gap && (d.gap.durationMs ?? now - d.gap.started));
</script>

{#if d}
  <p>
    Ready ahead: {d.readyCount} sentences · {d.readySeconds.toFixed(1)} seconds
  </p>
  <p>Preparation: {d.stage}{d.reason ? ` · ${d.reason}` : ""}</p>
  <p>
    Latest preparation: {d.lastPreparationMs === undefined
      ? "none yet"
      : `${(d.lastPreparationMs / 1000).toFixed(1)} seconds`}
  </p>
  <p>
    Underruns: {d.underruns} · total wait {(
      (d.totalWaitMs + (d.gap && d.gap.durationMs === undefined ? gapMs! : 0)) /
      1000
    ).toFixed(1)} seconds
  </p>
  {#if d.gap && gapMs !== undefined}
    <p>
      Last gap: sentence {d.gap.index + 1} · {(gapMs / 1000).toFixed(1)} seconds ·
      {d.gap.stage}
    </p>
  {/if}
  <ol start={snapshot.index + 1}>
    {#each d.sentences as sentence}
      <li>
        {sentence.text.length > 100
          ? `${sentence.text.slice(0, 100)}…`
          : sentence.text} · {sentence.status}{sentence.duration === undefined
          ? ""
          : ` · ${sentence.duration.toFixed(1)} seconds`}
      </li>
    {/each}
  </ol>
{/if}
