/** Early supported-operation policy, not script verification or authorization.
 * Called only after method Schema validation. Unknown/raw scripts still need
 * the Engine/Reviewed material-based policy before any signature is released.
 * Historical implementations and wire shapes remain for inspection/migration.
 */
const DISABLED_ISSUANCE = new Set([
  "tbc.ft.create",
  "tbc.nft.mint",
  "tbc.pool.create",
]);
const TRANSACTION_METHODS = new Set([
  "tbc_signTransaction", "tbc_sendTransaction", "tbc_signPreparedTransaction", "tbc_sendPreparedTransaction",
]);
const WORKFLOW_METHODS = new Set([
  "tbc_signWorkflow", "tbc_sendWorkflow", "tbc_signPreparedWorkflow", "tbc_sendPreparedWorkflow",
]);

export function disabledHistoricalIssuance(method: string, params: unknown): string | undefined {
  if (TRANSACTION_METHODS.has(method)) {
    const { intent } = params as { readonly intent: { readonly type: string } };
    return DISABLED_ISSUANCE.has(intent.type) ? intent.type : undefined;
  }
  if (WORKFLOW_METHODS.has(method)) {
    const { steps } = params as { readonly steps: readonly { readonly kind: string; readonly intent?: { readonly type: string } }[] };
    // Preflight the whole request, including dependent and continue-independent
    // steps, before any predecessor executes. LP from an existing pool's add
    // operation is deliberately NOT in the disabled issuance list.
    for (const step of steps) {
      if ((step.kind === "transaction" || step.kind === "preparedTransaction") &&
          step.intent !== undefined && DISABLED_ISSUANCE.has(step.intent.type)) return step.intent.type;
    }
  }
  return undefined;
}
