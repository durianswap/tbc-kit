function assertUnicodeScalars(value) {
  for (let index = 0; index < value.length; index += 1) {
    const codeUnit = value.charCodeAt(index);
    if (codeUnit >= 0xd800 && codeUnit <= 0xdbff) {
      const next = value.charCodeAt(index + 1);
      if (!(next >= 0xdc00 && next <= 0xdfff)) {
        throw new TypeError("JCS rejects strings with lone surrogates");
      }
      index += 1;
    } else if (codeUnit >= 0xdc00 && codeUnit <= 0xdfff) {
      throw new TypeError("JCS rejects strings with lone surrogates");
    }
  }
}

function serialize(value, ancestors) {
  if (value === null || typeof value === "boolean") return JSON.stringify(value);
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
  if (!value || typeof value !== "object") {
    throw new TypeError(`JCS rejects ${typeof value}`);
  }
  if (ancestors.has(value)) throw new TypeError("JCS rejects cyclic values");
  ancestors.add(value);
  try {
    if (Array.isArray(value)) {
      return `[${value.map((item) => serialize(item, ancestors)).join(",")}]`;
    }
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) {
      throw new TypeError("JCS accepts plain objects only");
    }
    return `{${Object.keys(value)
      .sort()
      .map((key) => {
        assertUnicodeScalars(key);
        return `${JSON.stringify(key)}:${serialize(value[key], ancestors)}`;
      })
      .join(",")}}`;
  } finally {
    ancestors.delete(value);
  }
}

export function canonicalize(value) {
  return serialize(value, new Set());
}
