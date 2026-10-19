import { requireOptionalNativeModule } from 'expo';
import { createTbcEngine } from '@tbc/kit/engine';
import identity from '../generated/identity.json';
import { connectNativeEngine, connectNativeKeylessEngine, type TbcKitEngineModule, type TbcKitKeylessModule } from './backend';

export function createExpoTbcEngineBackend() {
  return connectNativeEngine(
    requireOptionalNativeModule<TbcKitEngineModule>('TbcKitEngine'),
    identity.artifactSetId,
  );
}

export function createExpoTbcEngine() {
  return createTbcEngine({ backend: createExpoTbcEngineBackend() });
}

export function createExpoTbcKeylessEngine() {
  return connectNativeKeylessEngine(
    requireOptionalNativeModule<TbcKitKeylessModule>('TbcKitEngine'),
    identity.artifactSetId,
  );
}
