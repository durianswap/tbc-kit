// Semantic input budget, separate from the historical encoded-result grammar.
// Call only after the request Schema succeeds. No decode/allocation, I/O,
// normalization or change to the bytes bound into the approval is performed.
const MAX_PLAINTEXT_BYTES = 65_536;

function fits(message: { readonly encoding: string; readonly data: string }): boolean {
  const { encoding, data } = message;
  if (encoding === "hex") return data.length / 2 <= MAX_PLAINTEXT_BYTES;
  if (encoding === "base64") {
    const padding = data.endsWith("==") ? 2 : data.endsWith("=") ? 1 : 0;
    return data.length / 4 * 3 - padding <= MAX_PLAINTEXT_BYTES;
  }
  if (encoding !== "utf8") return false;
  let bytes = 0;
  for (let i = 0; i < data.length; i += 1) {
    const c = data.charCodeAt(i);
    if (c < 0x80) bytes += 1;
    else if (c < 0x800) bytes += 2;
    else if (c >= 0xd800 && c <= 0xdbff) {
      const low = data.charCodeAt(++i);
      if (!(low >= 0xdc00 && low <= 0xdfff)) return false;
      bytes += 4;
    } else if (c >= 0xdc00 && c <= 0xdfff) return false;
    else bytes += 3;
    if (bytes > MAX_PLAINTEXT_BYTES) return false;
  }
  return true;
}

/** Additional semantic check for already Schema-validated crypto requests. */
export function cryptoInputHasValidByteBudget(name: string, value: unknown): boolean {
  if (name === "encryptRequest" || name === "tbc_encrypt") {
    return fits((value as { message: Parameters<typeof fits>[0] }).message);
  }
  if (name === "workflowRequest" || name === "preparedWorkflowRequest" ||
      name === "tbc_signWorkflow" || name === "tbc_sendWorkflow" ||
      name === "tbc_signPreparedWorkflow" || name === "tbc_sendPreparedWorkflow") {
    return (value as { steps: readonly { kind: string; message: Parameters<typeof fits>[0] }[] })
      .steps.every(step => step.kind !== "encrypt" || fits(step.message));
  }
  return true;
}
