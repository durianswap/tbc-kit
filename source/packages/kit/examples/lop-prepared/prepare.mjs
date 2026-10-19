import { prepareTbcTransaction } from '@tbc/kit';

/** Existing public Prepared route; no custom witnesses, key custody or send.
 * network must be configured for request.chainId, using the normal Kit loader.
 */
export async function prepareLopProposal({ request, engine, network }) {
  if (!['tbc-lop-create', 'tbc-lop-cancel', 'tbc-lop-match'].includes(request?.intent?.type)) {
    throw new TypeError('This example requires a canonical LOP intent');
  }
  const prepared = await prepareTbcTransaction({ request, engine, network });
  // Show the actual DApp/backend boundary: public JSON data, not an Engine
  // closure or a private-key-bearing SDK instance. Serialization is not trust.
  return JSON.parse(JSON.stringify(prepared));
}

export async function signLopProposal(connection, prepared) {
  if (connection.chainId !== prepared.chainId || connection.account !== prepared.from) {
    throw new Error('Prepared account/network differs from the connected wallet');
  }
  return connection.wallet.signProposal(prepared);
}
