import {
  createMultisigClient,
  type MultisigEngine,
  type MultisigRequest,
  type MultisigSigner,
  type MultisigSignature,
} from "@tbc/kit/multisig";

// The transport exchanges public proposals/signatures, never keys. The wallet
// authenticates network, account and input material before its approve callback.
export async function propose(engine: MultisigEngine, request: MultisigRequest) {
  const client = createMultisigClient(engine);
  return client.exportProposal(await client.prepare(request));
}

export async function approveAndSign(engine: MultisigEngine, text: string, signer: MultisigSigner) {
  const client = createMultisigClient(engine);
  return client.sign(await client.importProposal(text), signer);
}

export async function collectAndFinalize(
  engine: MultisigEngine, text: string, sets: readonly (readonly MultisigSignature[])[],
) {
  const client = createMultisigClient(engine);
  const proposal = await client.importProposal(text);
  const signatures = await client.combine(proposal, ...sets);
  const progress = await client.verify(proposal, signatures);
  if (!progress.complete) return {progress, signatures};
  return {progress, transaction: await client.finalize(proposal, signatures)};
  // No automatic broadcast or automatic retry. Reuse the caller's existing
  // broadcast/reconciliation path after checking the current UTXOs.
}
