/** A bounded, in-memory log. Callers supply only non-sensitive diagnostic metadata. */
export class DebugLog {
  private entries: { elapsedMs: number; event: string; data: object }[] = [];
  private started = performance.now();
  private dropped = 0;

  record(event: string, data: object = {}) {
    if (this.entries.length === 500) {
      this.entries.shift();
      this.dropped++;
    }
    this.entries.push({
      elapsedMs: Math.round(performance.now() - this.started),
      event,
      data,
    });
  }

  export() {
    return JSON.stringify(
      { version: 1, dropped: this.dropped, entries: this.entries },
      null,
      2,
    );
  }

  download() {
    const url = URL.createObjectURL(
      new Blob([this.export()], { type: "application/json" }),
    );
    const link = document.createElement("a");
    link.href = url;
    link.download = "kokoro-debug-log.json";
    link.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }
}
