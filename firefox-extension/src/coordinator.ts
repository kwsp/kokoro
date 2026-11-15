export interface Owner {
  tabId: number;
  sessionId: string;
  leaseId: string;
}

const same = (left: Owner | undefined, right: Owner) =>
  left?.tabId === right.tabId &&
  left.sessionId === right.sessionId &&
  left.leaseId === right.leaseId;

/** One owner and one settled-before-replacement HTTP operation for the extension. */
export class SpeechCoordinator {
  private owner?: Owner;
  private active?: { owner: Owner; id: string; controller: AbortController };
  private tail: Promise<void> = Promise.resolve();
  private handoff: Promise<void> = Promise.resolve();

  constructor(
    private notify: (
      owner: Owner,
      type: "reader:stop" | "reader:settings",
    ) => Promise<unknown>,
  ) {}

  async claim(owner: Owner) {
    const previous = this.owner;
    this.owner = owner;
    this.active?.controller.abort();
    if (
      previous &&
      (previous.tabId !== owner.tabId || previous.sessionId !== owner.sessionId)
    )
      this.queueNotice(previous, "reader:stop");
    await this.handoff;
    this.assertOwner(owner);
  }

  private queueNotice(owner: Owner, type: "reader:stop" | "reader:settings") {
    // A third claimant must also wait for the first page's unfinished Stop.
    this.handoff = Promise.all([
      this.handoff,
      this.notify(owner, type).catch(() => {}),
    ]).then(() => {});
  }

  private assertOwner(owner: Owner) {
    if (!same(this.owner, owner))
      throw new Error("Another page has taken over reading.");
  }

  run<T>(
    owner: Owner,
    id: string,
    work: (signal: AbortSignal) => Promise<T>,
  ): Promise<T> {
    this.assertOwner(owner);
    this.active?.controller.abort();
    const request = { owner, id, controller: new AbortController() };
    this.active = request;
    const handoff = this.handoff;
    const result = this.tail
      .then(() => handoff)
      .then(async () => {
        request.controller.signal.throwIfAborted();
        this.assertOwner(owner);
        const value = await work(request.controller.signal);
        request.controller.signal.throwIfAborted();
        this.assertOwner(owner);
        return value;
      })
      .finally(() => {
        if (this.active === request) this.active = undefined;
      });
    this.tail = result.then(
      () => {},
      () => {},
    );
    return result;
  }

  cancel(owner: Owner, id: string) {
    if (this.active?.id === id && same(this.active.owner, owner))
      this.active.controller.abort();
  }

  release(owner: Owner) {
    if (!same(this.owner, owner)) return;
    this.owner = undefined;
    this.active?.controller.abort();
  }

  removeTab(tabId: number) {
    if (this.owner?.tabId === tabId) this.release(this.owner);
  }

  async settingsChanged() {
    const owner = this.owner;
    if (!owner) return;
    this.release(owner);
    this.queueNotice(owner, "reader:settings");
    await this.handoff;
  }
}
