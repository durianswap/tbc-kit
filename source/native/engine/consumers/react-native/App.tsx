import React, { useEffect, useState } from 'react';
import { Platform, SafeAreaView, Text } from 'react-native';
import * as FileSystem from 'expo-file-system/legacy';
import { createExpoTbcEngine, createExpoTbcEngineBackend } from './modules/tbc-kit-engine/src';
import vectors from './vectors.json';
import identity from './modules/tbc-kit-engine/generated/identity.json';

export default function App() {
  const [status, setStatus] = useState('Running isolated shared SDK checks…');
  useEffect(() => {
    async function run() {
      const backend = createExpoTbcEngineBackend();
      const start = performance.now();
      for (const vector of vectors) {
        const actual = await backend.call(vector.method as any, vector.input);
        if (actual !== vector.expected) throw new Error(`Vector mismatch: ${vector.method}`);
      }
      const normalized = JSON.parse(vectors[0].expected);
      const parallel = await Promise.all(Array.from({ length: 16 }, () => backend.call('normalizeRequest', vectors[0].input)));
      if (parallel.some(value => value !== vectors[0].expected)) throw new Error('Concurrent response mismatch');
      const engine = createExpoTbcEngine();
      const result = await engine.normalizeRequest(JSON.parse(vectors[0].input));
      if (result.requestHash !== normalized.result.requestHash) throw new Error('Kit facade mismatch');
      const report = { marker: 'TBC_SHARED_SDK_EXPO_PASS', platform: Platform.OS,
        hermes: Boolean((globalThis as any).HermesInternal), vectors: vectors.length, concurrent: 16,
        identity, elapsedMs: Math.round(performance.now() - start), timestamp: new Date().toISOString() };
      if (!report.hermes) throw new Error('Hermes not active');
      await FileSystem.writeAsStringAsync(FileSystem.documentDirectory + 'shared-sdk-report.json', JSON.stringify(report));
      console.log(JSON.stringify(report));
      setStatus(JSON.stringify(report, null, 2));
    }
    run().catch(async error => {
      const report = { marker: 'TBC_SHARED_SDK_EXPO_FAIL', error: String(error), platform: Platform.OS };
      await FileSystem.writeAsStringAsync(FileSystem.documentDirectory + 'shared-sdk-report.json', JSON.stringify(report));
      console.error(JSON.stringify(report));
      setStatus(JSON.stringify(report));
    });
  }, []);
  return <SafeAreaView style={{ flex: 1, padding: 28, justifyContent: 'center' }}>
    <Text selectable>{status}</Text><Text>No wallet, secrets, network or broadcast.</Text>
  </SafeAreaView>;
}
