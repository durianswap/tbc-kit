type Listener = (...args: readonly unknown[]) => void;

export class TbcEventEmitter {
  readonly #listeners = new Map<string, Listener[]>();

  on(event: string, listener: Listener): void {
    const listeners = this.#listeners.get(event);
    if (listeners === undefined) {
      this.#listeners.set(event, [listener]);
    } else {
      listeners.push(listener);
    }
  }

  removeListener(event: string, listener: Listener): void {
    const listeners = this.#listeners.get(event);
    if (listeners === undefined) return;
    const index = listeners.lastIndexOf(listener);
    if (index === -1) return;
    listeners.splice(index, 1);
    if (listeners.length === 0) this.#listeners.delete(event);
  }

  emit(event: string, payload: unknown): void {
    const listeners = this.#listeners.get(event);
    if (listeners === undefined) return;
    for (const listener of [...listeners]) {
      try {
        listener(payload);
      } catch {
        // A DApp listener cannot interrupt delivery to other registered listeners.
      }
    }
  }

  clear(): void {
    this.#listeners.clear();
  }
}
