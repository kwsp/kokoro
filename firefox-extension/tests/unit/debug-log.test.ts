import { describe, expect, it } from "vitest";
import { DebugLog } from "../../src/debug-log";

describe("debug log", () => {
  it("retains only the newest 500 events", () => {
    const log = new DebugLog();
    for (let index = 0; index < 503; index++) log.record("event", { index });
    const result = JSON.parse(log.export());
    expect(result.dropped).toBe(3);
    expect(result.entries).toHaveLength(500);
    expect(result.entries[0].data.index).toBe(3);
  });
});
