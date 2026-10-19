/** TBC display text to atomic units. FT amounts require their own decimals. */
export function parseTbcAmount(value) {
  if (typeof value !== "string" || !/^(0|[1-9][0-9]*)(\.[0-9]{1,6})?$/.test(value)) {
    throw new TypeError("请输入最多 6 位小数的 TBC 金额。");
  }
  const [whole, fraction = ""] = value.split(".");
  const atomic = BigInt(whole) * 1_000_000n + BigInt(fraction.padEnd(6, "0"));
  if (atomic <= 0n) throw new TypeError("金额必须大于 0。");
  return atomic.toString();
}

export function formatTbcAmount(atomic) {
  if (typeof atomic !== "string" || !/^(0|[1-9][0-9]*)$/.test(atomic)) {
    throw new TypeError("余额必须是 atomic 整数字符串。");
  }
  const value = BigInt(atomic);
  const fraction = (value % 1_000_000n).toString().padStart(6, "0").replace(/0+$/, "");
  return `${value / 1_000_000n}${fraction ? `.${fraction}` : ""}`;
}
