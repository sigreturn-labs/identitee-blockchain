// @vitest-environment happy-dom
import { render } from "preact";
import { afterEach, expect, it } from "vitest";
import { type IdentitySecret, SecretBlock } from "../src/pages/me-private.tsx";
import type { Saving } from "../src/pages/me-sections.tsx";

const saving = { status: null, pending: false, save: async () => false, touch() {} } as unknown as Saving;
const secret = { state: { phase: "none" }, secret: null, pending: null } as unknown as IdentitySecret;

let root: HTMLElement | null = null;
afterEach(() => {
  if (root) render(null, root);
  root?.remove();
  root = null;
});

it("keeps a passphrase typed before the block's first effects run", async () => {
  root = document.body.appendChild(document.createElement("div"));
  // no act(): the effects run later, as in a browser, and the keys arrive before them
  render(<SecretBlock secret={secret} saving={saving} />, root);
  const field = root.querySelector<HTMLInputElement>('input[type="password"]')!;
  field.value = "typed straight away";
  field.dispatchEvent(new Event("input", { bubbles: true }));
  await new Promise((r) => setTimeout(r, 50));
  expect(root.querySelector<HTMLInputElement>('input[type="password"]')!.value).toBe("typed straight away");
});
