import { describe, expect, it, vi } from "vitest";
import { SpeechCoordinator, type Owner } from "../../src/coordinator";
const first: Owner = { tabId: 1, sessionId: "doc1", leaseId: "lease1" };
const second: Owner = { tabId: 2, sessionId: "doc2", leaseId: "lease2" };
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((yes) => {
    resolve = yes;
  });
  return { resolve, promise };
}
const settle = async () => {
  for (let n = 0; n < 8; n++) await Promise.resolve();
};

describe("global speech coordinator", () => {
  it("waits for the previous page to acknowledge Stop and rejects superseded claims", async () => {
    const gate = deferred<void>();
    const notify = vi.fn(() => gate.promise);
    const coordinator = new SpeechCoordinator(notify);
    await coordinator.claim(first);
    const next = coordinator.claim(second);
    let claimed = false;
    void next.then(() => {
      claimed = true;
    });
    await settle();
    expect(claimed).toBe(false);
    expect(notify).toHaveBeenCalledWith(first, "reader:stop");
    gate.resolve();
    await next;
    expect(() => coordinator.run(first, "old", async () => 1)).toThrow(
      "Another page",
    );
  });
  it("serializes replacement requests until an aborted operation settles", async () => {
    const coordinator = new SpeechCoordinator(async () => {});
    await coordinator.claim(first);
    const old = deferred<number>();
    let oldSignal!: AbortSignal;
    const result = coordinator
      .run(first, "old", (signal) => {
        oldSignal = signal;
        return old.promise;
      })
      .catch((error) => error);
    await settle();
    const work = vi.fn(async () => 2);
    const replacement = coordinator.run(first, "new", work);
    await settle();
    expect(oldSignal.aborted).toBe(true);
    expect(work).not.toHaveBeenCalled();
    old.resolve(1);
    await result;
    expect(await replacement).toBe(2);
    expect(work).toHaveBeenCalledOnce();
  });
  it("ignores stale cancellation/releases and cancels the matching owner", async () => {
    const coordinator = new SpeechCoordinator(async () => {});
    await coordinator.claim(first);
    const gate = deferred<void>();
    let signal!: AbortSignal;
    const result = coordinator
      .run(first, "new", (value) => {
        signal = value;
        return gate.promise;
      })
      .catch((error) => error);
    await settle();
    coordinator.cancel(first, "old");
    coordinator.cancel(second, "new");
    coordinator.release(second);
    expect(signal.aborted).toBe(false);
    coordinator.cancel(first, "new");
    expect(signal.aborted).toBe(true);
    gate.resolve();
    await result;
  });
  it("does not notify the same document on Resume, but invalidates its previous lease", async () => {
    const notify = vi.fn().mockResolvedValue(undefined);
    const coordinator = new SpeechCoordinator(notify);
    await coordinator.claim(first);
    await coordinator.claim({ ...first, leaseId: "resumed" });
    expect(notify).not.toHaveBeenCalled();
    expect(() => coordinator.run(first, "old", async () => 1)).toThrow();
  });
  it("releases tabs and settings without accepting obsolete work", async () => {
    const notify = vi.fn().mockResolvedValue(undefined);
    const coordinator = new SpeechCoordinator(notify);
    await coordinator.claim(first);
    coordinator.removeTab(2);
    expect(await coordinator.run(first, "ok", async () => 1)).toBe(1);
    await coordinator.settingsChanged();
    expect(notify).toHaveBeenCalledWith(first, "reader:settings");
    expect(() => coordinator.run(first, "old", async () => 1)).toThrow();
    await coordinator.claim(second);
    coordinator.removeTab(2);
    expect(() => coordinator.run(second, "closed", async () => 1)).toThrow();
  });
  it("a third claim invalidates a second claim waiting on old-page cleanup", async () => {
    const gate = deferred<void>();
    const coordinator = new SpeechCoordinator((owner) =>
      owner.tabId === 1 ? gate.promise : Promise.resolve(),
    );
    await coordinator.claim(first);
    const stale = coordinator.claim(second).catch((error) => error);
    const third = { tabId: 3, sessionId: "doc3", leaseId: "lease3" };
    let claimed = false;
    const current = coordinator.claim(third).then(() => {
      claimed = true;
    });
    await settle();
    expect(claimed).toBe(false);
    gate.resolve();
    await current;
    expect(await stale).toBeInstanceOf(Error);
    expect(await coordinator.run(third, "current", async () => 3)).toBe(3);
  });
  it("waits for a settings notification to stop the old page before admitting another page", async () => {
    const gate = deferred<void>();
    const coordinator = new SpeechCoordinator(() => gate.promise);
    await coordinator.claim(first);
    const updating = coordinator.settingsChanged();
    let claimed = false;
    const next = coordinator.claim(second).then(() => {
      claimed = true;
    });
    const work = vi.fn(async () => 2);
    const result = coordinator.run(second, "new", work);
    await settle();
    expect(claimed).toBe(false);
    expect(work).not.toHaveBeenCalled();
    gate.resolve();
    await updating;
    await next;
    expect(await result).toBe(2);
  });
});
