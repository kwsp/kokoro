const HOST_ID = "kokoro-reader-controls";
const existing = document.getElementById(HOST_ID);
if (existing)
  existing.shadowRoot?.querySelector<HTMLButtonElement>("button")?.focus();
else mount();

function mount() {
  const selection = window.getSelection();
  const selected =
    selection && !selection.isCollapsed && selection.rangeCount
      ? selection.getRangeAt(0).cloneRange()
      : undefined;
  const target = document.querySelector("article p, main p");
  const range = selected ?? (target ? document.createRange() : undefined);
  if (!selected && target) range?.selectNodeContents(target);
  const host = document.createElement("div");
  host.id = HOST_ID;
  host.style.cssText =
    "all:initial;position:fixed;bottom:20px;right:20px;z-index:2147483647;max-width:calc(100vw - 24px)";
  const shadow = host.attachShadow({ mode: "open" });
  const style = document.createElement("style");
  style.textContent =
    ":host{color-scheme:light}section{font:14px system-ui;color:#17252c;background:#fff;border:1px solid #c8d5db;border-radius:12px;padding:12px;box-shadow:0 4px 22px #0002}nav{display:flex;gap:8px;align-items:center;flex-wrap:wrap}button{font:inherit;padding:6px 10px;border-radius:6px;border:1px solid #bbc9ce;background:#f5f9fa;color:inherit;cursor:pointer}button:focus-visible{outline:3px solid #238072}p{margin:8px 0 0;font-size:12px}";
  shadow.append(style);
  const panel = document.createElement("section");
  panel.setAttribute("aria-label", "Kokoro reader");
  const nav = document.createElement("nav");
  const title = document.createElement("strong");
  title.textContent = "Kokoro";
  nav.append(title);
  const status = document.createElement("p");
  status.setAttribute("role", "status");
  const update = (state: string, text = state) => {
    host.dataset.state = state.toLowerCase();
    status.textContent = text;
  };
  let generation = 0;
  let context: AudioContext | undefined;
  let source: AudioBufferSourceNode | undefined;
  const highlightStyle = document.createElement("style");
  highlightStyle.textContent =
    "::highlight(kokoro-speaking){background-color:#ffe39a;color:#17252c}";
  document.documentElement.append(highlightStyle);
  function clearHighlight() {
    CSS.highlights?.delete("kokoro-speaking");
  }
  function stop() {
    generation++;
    source?.stop();
    source = undefined;
    clearHighlight();
    void browser.runtime.sendMessage({ type: "speech:cancel" });
    update("Ready");
  }
  const addButton = (text: string, click: () => void) => {
    const button = document.createElement("button");
    button.type = "button";
    button.textContent = text;
    button.addEventListener("click", click);
    nav.append(button);
    return button;
  };
  const play = addButton("Play", () => {
    if (!range?.toString().trim()) {
      update("Error", "Select a passage, then activate Kokoro again.");
      return;
    }
    stop();
    const current = generation;
    context ??= new AudioContext();
    const audioContext = context;
    const resume = audioContext.resume();
    update("Preparing");
    void (async () => {
      try {
        await resume;
        const result = (await browser.runtime.sendMessage({
          type: "speech:generate",
          text: range.toString(),
        })) as { ok: boolean; audio?: ArrayBuffer; error?: string };
        if (generation !== current) return;
        if (!result.ok || !result.audio)
          throw new Error(result.error ?? "No audio received.");
        const decoded = await audioContext.decodeAudioData(result.audio);
        if (generation !== current) return;
        source = audioContext.createBufferSource();
        source.buffer = decoded;
        source.connect(audioContext.destination);
        if (CSS.highlights && typeof Highlight !== "undefined")
          CSS.highlights.set("kokoro-speaking", new Highlight(range));
        source.onended = () => {
          if (generation === current) {
            clearHighlight();
            update("Finished");
          }
        };
        source.start();
        update("Playing");
      } catch (error) {
        if (generation === current)
          update(
            "Error",
            error instanceof Error ? error.message : "Playback failed.",
          );
      }
    })();
  });
  addButton("Stop", stop);
  addButton("Settings", () => {
    void browser.runtime.sendMessage({ type: "settings:open" });
  });
  addButton("Close", () => {
    stop();
    void context?.close();
    highlightStyle.remove();
    host.remove();
  });
  panel.append(nav, status);
  shadow.append(panel);
  document.documentElement.append(host);
  update("Ready", selected ? "Selection ready." : "First paragraph ready.");
  play.focus();
  window.addEventListener(
    "pagehide",
    () => {
      stop();
      void context?.close();
    },
    { once: true },
  );
}
