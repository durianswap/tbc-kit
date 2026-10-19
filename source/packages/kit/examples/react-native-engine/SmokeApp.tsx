// Copy to App.tsx in a dedicated Expo consumer after installing the local module.
// No accounts, permissions, Signer, network or broadcast are configured here.
import React, { useEffect, useState } from 'react';
import { SafeAreaView, Text } from 'react-native';
import { createExpoTbcEngine, createExpoTbcEngineBackend } from './modules/tbc-kit-engine/src';

export default function App() {
  const [status, setStatus] = useState('Checking JS → Expo → Rust → Kit…');
  useEffect(() => {
    let mounted = true;
    async function run() {
      const engine = createExpoTbcEngine();
      const input = { version: '1.0', request: { version: '1.0',
        chainId: 'tbc:0000000000cee779eb6a6c2ce087218a',
        from: '1BgGZ9tcN4rm9KBzDn7KprQz87SZ26SAMH',
        intent: { version: '1.0', type: 'tbc.transfer', to: '1cMh228HTCiwS8ZsaakH8A8wze1JR5ZsP', amount: '1000' },
      } } as const;
      const expected = '3a7572cd08c60fa0673d3262e5b2b3e6e85b21dc35726d88ab245ac7b273b5e0';
      const start = performance.now();
      const results = await Promise.all(Array.from({ length: 8 }, () => engine.normalizeRequest(input)));
      if (!results.every(result => result.requestHash === expected)) throw new Error('Native result mismatch');
      const backend = createExpoTbcEngineBackend();
      for (const method of ['plan', 'validate', 'finalize'] as const) {
        if (JSON.parse(await backend.call(method, '{}')).ok !== false) throw new Error('Invalid input accepted');
      }
      const result = `TBC_BRIDGE_APP_PASS normalize=8 invalid=3 elapsedMs=${Math.round(performance.now() - start)}`;
      console.log(result);
      if (mounted) setStatus(result);
    }
    run().catch(error => {
      const message = `TBC_BRIDGE_APP_FAIL ${error instanceof Error ? error.message : 'unknown'}`;
      console.error(message);
      if (mounted) setStatus(message);
    });
    return () => { mounted = false; };
  }, []);
  return <SafeAreaView style={{ flex: 1, justifyContent: 'center', padding: 24 }}>
    <Text selectable testID="tbc-bridge-result">{status}</Text>
    <Text>Local keyless check only. No funds or network activity.</Text>
  </SafeAreaView>;
}
