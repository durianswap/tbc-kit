import { ownedJsonValues } from "./immutable-json-ownership.js";

// A bounded, private serialization cache for Core-created immutable snapshots.
// This is not a hash/validation cache. New wrappers, state hashes and binding
// comparisons still execute. Bounds affect only reuse, never accepted inputs.
const MAX_CACHE_CHARACTERS = 2 * 1024 * 1024;
const MAX_CACHE_ENTRIES = 4096;
const MAX_ENTRY_CHARACTERS = 256 * 1024;
let serializedOwnedValues = new WeakMap<object, string>();
let cachedCharacters = 0;
let cachedEntries = 0;

function rememberOwned(value: object, text: string, reusable: boolean): string {
  if (reusable && text.length <= MAX_ENTRY_CHARACTERS) {
    if (cachedCharacters + text.length > MAX_CACHE_CHARACTERS || cachedEntries >= MAX_CACHE_ENTRIES) {
      serializedOwnedValues = new WeakMap<object, string>();
      cachedCharacters = 0;
      cachedEntries = 0;
    }
    serializedOwnedValues.set(value, text);
    cachedCharacters += text.length;
    cachedEntries += 1;
  }
  return text;
}

function assertUnicodeScalars(value: string): void {
  // Check the common scalar-only case in the VM, not one JS call per code
  // unit of transaction hex. Surrogate-containing strings keep exact checks.
  if (!/[\ud800-\udfff]/.test(value)) return;
  for (let index = 0; index < value.length; index += 1) {
    const codeUnit = value.charCodeAt(index);
    if (codeUnit >= 0xd800 && codeUnit <= 0xdbff) {
      const next = value.charCodeAt(index + 1);
      if (!(next >= 0xdc00 && next <= 0xdfff)) {
        throw new TypeError("JCS rejects strings with a lone surrogate");
      }
      index += 1;
    } else if (codeUnit >= 0xdc00 && codeUnit <= 0xdfff) {
      throw new TypeError("JCS rejects strings with a lone surrogate");
    }
  }
}

function serialize(value: unknown, ancestors: Set<object>): string {
  if (value === null || typeof value === "boolean") {
    return JSON.stringify(value);
  }
  if (typeof value === "string") {
    assertUnicodeScalars(value);
    return JSON.stringify(value);
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value)) {
      throw new TypeError("JCS rejects non-finite numbers");
    }
    return JSON.stringify(value);
  }
  if (typeof value !== "object") {
    throw new TypeError(`JCS rejects ${typeof value}`);
  }
  const reusable = ownedJsonValues.has(value);
  const cached = reusable ? serializedOwnedValues.get(value) : undefined;
  if (cached !== undefined) return cached;
  if (ancestors.has(value)) {
    throw new TypeError("JCS rejects cyclic values");
  }

  ancestors.add(value);
  try {
    if (Array.isArray(value)) {
      const items: string[] = [];
      for (const item of value) items.push(serialize(item, ancestors));
      return rememberOwned(value, `[${items.join(",")}]`, reusable);
    }

    const prototype = Object.getPrototypeOf(value) as object | null;
    if (prototype !== Object.prototype && prototype !== null) {
      throw new TypeError("JCS accepts plain objects only");
    }
    if (
      Object.getOwnPropertySymbols(value).some((symbol) =>
        Object.prototype.propertyIsEnumerable.call(value, symbol),
      )
    ) {
      throw new TypeError("JCS rejects enumerable symbol keys");
    }

    const record = value as Record<string, unknown>;
    const members = Object.keys(record)
      .sort()
      .map((key) => {
        assertUnicodeScalars(key);
        return `${JSON.stringify(key)}:${serialize(record[key], ancestors)}`;
      });
    return rememberOwned(value, `{${members.join(",")}}`, reusable);
  } finally {
    ancestors.delete(value);
  }
}

export function canonicalize(value: unknown): string {
  return serialize(value, new Set<object>());
}
