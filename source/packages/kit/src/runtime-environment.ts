/** Internal React Native-safe feature test. Never reference optional globals bare. */
export function hasBrowserWalletStandardEnvironment(): boolean {
  return (
    "window" in globalThis &&
    "document" in globalThis &&
    typeof Reflect.get(globalThis, "Event") === "function"
  );
}
