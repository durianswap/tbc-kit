// Independent synthetic probe. Never connect this app to a wallet or a chain.
import React, { useEffect, useState } from 'react';
import { Platform, SafeAreaView, Text } from 'react-native';
import { requireOptionalNativeModule } from 'expo';
import * as FileSystem from 'expo-file-system/legacy';
import { createExpoTbcEngine, createExpoTbcEngineBackend, createExpoTbcKeylessEngine } from './modules/tbc-kit-engine/src';
import vectors from './vectors.json';
import keylessVectors from './keyless-vectors.json';
import identity from './modules/tbc-kit-engine/generated/identity.json';
import proof from './probe-provenance.json';

export default function App() {
  const [status, setStatus] = useState('Running independent RN Keyless probe…');
  useEffect(() => {
    async function run() {
      let fetches = 0;
      globalThis.fetch = (async () => { fetches++; throw new Error('PROBE_NETWORK_FORBIDDEN'); }) as typeof fetch;
      const start = performance.now();
      const backend = createExpoTbcEngineBackend();
      for (const vector of vectors) {
        if (await backend.call(vector.method as any, vector.input) !== vector.expected) throw new Error('ENGINE_VECTOR_MISMATCH');
      }
      const engine = createExpoTbcEngine();
      const normalized = await engine.normalizeRequest(JSON.parse(vectors[0].input));
      if (normalized.requestHash !== JSON.parse(vectors[0].expected).result.requestHash) throw new Error('ENGINE_FACADE_MISMATCH');
      const keyless = createExpoTbcKeylessEngine();
      const operations = JSON.parse(await keyless.protocolInfo()).operations;
      let rejections = 0;
      for (const vector of keylessVectors) {
        const expected = JSON.parse(vector.expected);
        if (typeof expected.error === 'string') {
          let failed = false;
          try { await keyless.execute(vector.method, vector.input); }
          catch (error) { failed = error instanceof Error && error.message === expected.error; }
          if (!failed) throw new Error('KEYLESS_ERROR_MISMATCH');
          rejections++;
        } else if (await keyless.execute(vector.method, vector.input) !== vector.expected) {
          throw new Error('KEYLESS_VECTOR_MISMATCH');
        }
      }
      const positive = keylessVectors.filter(v => typeof JSON.parse(v.expected).error !== 'string');
      await Promise.all(Array.from({ length: 16 }, async (_, i) => {
        const v = positive[i % positive.length];
        if (await keyless.execute(v.method, v.input) !== v.expected) throw new Error('CONCURRENT_KEYLESS_MISMATCH');
      }));
      const native = requireOptionalNativeModule<any>('TbcKitEngine');
      let unsupportedRejected = false;
      try { await native.callKeyless('sign', '{}'); } catch { unsupportedRejected = true; }
      if (!unsupportedRejected || operations.length !== 10 || fetches !== 0) throw new Error('PROBE_BOUNDARY_FAILURE');
      const report = { marker: 'TBC_KEYLESS_RN_PROBE_PASS', platform: Platform.OS,
        hermes: Boolean((globalThis as any).HermesInternal), identity, proof,
        engineVectors: vectors.length, keylessVectors: keylessVectors.length,
        keylessPositive: positive.length, keylessErrorRejections: rejections,
        operations: operations.length, concurrent: 16, nativeUnsupportedRejected: unsupportedRejected,
        fetches, broadcasts: 0, elapsedMs: Math.round(performance.now() - start),
        scope: `${identity.kitVersion}; ${proof.templatePatch}; synthetic; not wallet custody or chain` };
      if (!report.hermes) throw new Error('HERMES_NOT_ACTIVE');
      await FileSystem.writeAsStringAsync(FileSystem.documentDirectory + 'keyless-rn-report.json', JSON.stringify(report));
      console.log(JSON.stringify(report));
      setStatus(JSON.stringify(report, null, 2));
    }
    run().catch(async () => {
      // Never print raw transaction material or native exception payloads.
      const report = { marker: 'TBC_KEYLESS_RN_PROBE_FAIL', platform: Platform.OS };
      await FileSystem.writeAsStringAsync(FileSystem.documentDirectory + 'keyless-rn-report.json', JSON.stringify(report));
      console.error(JSON.stringify(report));
      setStatus(JSON.stringify(report));
    });
  }, []);
  return <SafeAreaView style={{ flex: 1, padding: 20, justifyContent: 'center' }}>
    <Text selectable>{status}</Text><Text>No wallet, secrets, network or broadcast.</Text>
  </SafeAreaView>;
}
