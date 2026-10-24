// Unsaved edits: while any part of a page holds some, leaving the page asks first. A reload or a
// closed tab gets the browser's own question (beforeunload); a link inside the app (the logo, the
// menu) gets a confirm, before the router takes the click.

import { useEffect } from "preact/hooks";

const dirty = new Set<string>();

const LEAVE = "You have changes that are not saved. Leave this page and lose them?";

function beforeUnload(e: BeforeUnloadEvent): void {
  e.preventDefault();
  // older browsers want a value; the text itself is never shown
  e.returnValue = "";
}

function linkClick(e: MouseEvent): void {
  if (e.defaultPrevented || e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
  const link = (e.target as Element | null)?.closest?.("a[href]");
  if (!(link instanceof HTMLAnchorElement) || link.target === "_blank" || link.origin !== location.origin) return;
  if (link.pathname === location.pathname) return;
  if (!confirm(LEAVE)) {
    e.preventDefault();
    e.stopImmediatePropagation();
  }
}

// Back and Forward have already changed the address when popstate fires: a refusal keeps the router
// from seeing the move and puts the address of the page still on screen back (pushState fires no
// popstate). The address is the one of the last page the router showed.
let onScreen = location.href;
function historyMove(e: PopStateEvent): void {
  if (confirm(LEAVE)) return;
  e.stopImmediatePropagation();
  history.pushState(null, "", onScreen);
}

function sync(): void {
  if (dirty.size > 0) {
    onScreen = location.href;
    addEventListener("beforeunload", beforeUnload);
    // capture: before the router's own listeners turn the click or the history move into a navigation
    addEventListener("click", linkClick, true);
    addEventListener("popstate", historyMove, true);
  } else {
    removeEventListener("beforeunload", beforeUnload);
    removeEventListener("click", linkClick, true);
    removeEventListener("popstate", historyMove, true);
  }
}

/** Whether leaving now is fine: nothing unsaved, or the person said so. */
export function mayLeave(): boolean {
  return dirty.size === 0 || confirm(LEAVE);
}

/** Mark `key` as holding unsaved edits while `isDirty` is true. */
export function useUnsaved(key: string, isDirty: boolean): void {
  useEffect(() => {
    if (!isDirty) return;
    dirty.add(key);
    sync();
    return () => {
      dirty.delete(key);
      sync();
    };
  }, [key, isDirty]);
}
