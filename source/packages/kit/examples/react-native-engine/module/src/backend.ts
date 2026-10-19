import { createNativeTbcEngineBackend, type TbcEngineMethod } from '@tbc/kit/engine';
import { createNativeTbcKeylessEngine } from '@tbc/kit';

type KeylessExecute = Parameters<typeof createNativeTbcKeylessEngine>[0];

export interface TbcKitKeylessModule {
  readonly artifactSetId: string;
  callKeyless: KeylessExecute;
}

export interface TbcKitEngineModule {
  readonly artifactSetId: string;
  call(method: TbcEngineMethod, canonicalInput: string): Promise<string>;
}

/** One startup check, no extra bridge calls/JSON parsing on the transaction path. */
export function connectNativeEngine(native: TbcKitEngineModule | null, expectedArtifactSetId: string) {
  if (!native || typeof native.call !== 'function') {
    throw new Error('TBC_NATIVE_UNAVAILABLE: rebuild the native app; Expo Go is unsupported');
  }
  if (!/^[a-f0-9]{64}$/.test(expectedArtifactSetId) || native.artifactSetId !== expectedArtifactSetId) {
    throw new Error('TBC_NATIVE_ARTIFACT_MISMATCH: sync artifacts and rebuild; JS-only updates are insufficient');
  }
  return createNativeTbcEngineBackend((method, input) => native.call(method, input));
}

/** Same compiled identity and shared allowlist; no WASM fallback or extra reads. */
export function connectNativeKeylessEngine(native: TbcKitKeylessModule | null, expectedArtifactSetId: string) {
  if (!native || typeof native.callKeyless !== 'function') {
    throw new Error('TBC_NATIVE_UNAVAILABLE: rebuild with the Keyless companion bridge; Expo Go is unsupported');
  }
  if (!/^[a-f0-9]{64}$/.test(expectedArtifactSetId) || native.artifactSetId !== expectedArtifactSetId) {
    throw new Error('TBC_NATIVE_ARTIFACT_MISMATCH: sync artifacts and rebuild; JS-only updates are insufficient');
  }
  return createNativeTbcKeylessEngine((operation, input) => native.callKeyless(operation, input));
}
