// No test reaches the network: `fetch` refuses unless a test replaces it, and EventSource is a fake
// that never connects (tests drive it through `FakeEventSource.instances`).
import { beforeEach } from "vitest";

export class FakeEventSource {
  static instances: FakeEventSource[] = [];
  readonly listeners = new Map<string, Array<(e: MessageEvent) => void>>();
  onerror: ((e: Event) => void) | null = null;
  closed = false;
  constructor(readonly url: string) {
    FakeEventSource.instances.push(this);
  }
  addEventListener(type: string, listener: (e: MessageEvent) => void) {
    this.listeners.set(type, [...(this.listeners.get(type) ?? []), listener]);
  }
  close() {
    this.closed = true;
  }
  emit(type: string, data: string) {
    for (const listener of this.listeners.get(type) ?? []) listener(new MessageEvent(type, { data }));
  }
  fail() {
    this.onerror?.(new Event("error"));
  }
}

const refuse = () => Promise.reject(new TypeError("no network in tests"));
globalThis.fetch = refuse as typeof fetch;
(globalThis as { EventSource: unknown }).EventSource = FakeEventSource;
beforeEach(() => {
  globalThis.fetch = refuse as typeof fetch;
  (globalThis as { EventSource: unknown }).EventSource = FakeEventSource;
  FakeEventSource.instances = [];
});
