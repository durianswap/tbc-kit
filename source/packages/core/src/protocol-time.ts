/** UTC protocol time. Validation never rewrites bytes already covered by a hash. */
const UTC_TIME = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z$/u;

export function parseProtocolTimestamp(value: string): number {
  if (!UTC_TIME.test(value)) throw new TypeError("Invalid UTC protocol timestamp");
  const milliseconds = Date.parse(value);
  const canonical = value.length === 20
    ? `${value.slice(0, 19)}.000Z`
    : `${value.slice(0, 20)}${value.slice(20, -1).padEnd(3, "0")}Z`;
  if (!Number.isFinite(milliseconds) || new Date(milliseconds).toISOString() !== canonical) {
    throw new TypeError("Invalid protocol calendar timestamp");
  }
  return milliseconds;
}

/** Use only when creating unbound material; never normalize signed/bound input. */
export function formatProtocolTimestamp(milliseconds: number): string {
  if (!Number.isSafeInteger(milliseconds)) throw new TypeError("Invalid protocol clock");
  const value = new Date(milliseconds).toISOString();
  if (!UTC_TIME.test(value)) throw new TypeError("Protocol clock outside four-digit year range");
  return value;
}
