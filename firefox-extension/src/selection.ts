import { captureSelection } from "./mapping";

/** Keep a page selection available when focusing reader controls collapses it. */
export function watchSelection(
  document: Document,
  controls: HTMLElement,
  changed: (ranges: Range[]) => void,
) {
  const update = () => {
    if (document.activeElement === controls) return;
    changed(captureSelection(document.getSelection()));
  };
  document.addEventListener("selectionchange", update);
  // Capture before the button receives focus, including editors that clear
  // their selection on blur and clicks before selectionchange is dispatched.
  controls.addEventListener("mousedown", update);
  return () => {
    document.removeEventListener("selectionchange", update);
    controls.removeEventListener("mousedown", update);
  };
}
