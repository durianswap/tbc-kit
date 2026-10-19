// Controlled platform authority. Never use a DApp-provided origin as authority.
export async function discoverySession(runtime, { account, origin = 'https://discovery.example', profile = 'tbc-kit-wallet', sessionId = 'discovery-fixture' }) {
  const currentContext = { sessionId, origin, topOrigin: origin, transport: 'remote', frame: 'top', createdAt: '2026-09-26T00:00:00Z' };
  const currentSession = { version: '1.0', scope: { walletProfile: profile, sessionId },
    state: { version: '1.0', sessionId, revision: '0', connected: true, activeChainId: account.chainId, activeAccountIds: [account.accountId] } };
  return runtime.openSession({ authority: {
    read: async () => structuredClone({ currentContext, currentSession }),
    compareAndSwapSession: async () => { throw new Error('Unexpected fixture commit'); },
  } });
}
