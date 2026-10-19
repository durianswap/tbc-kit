import {createRequire} from 'node:module';
import {dirname,join,resolve} from 'node:path';

// Separate build-time tools from any wallet checkout or installed React Native app.
export const flutterPeerModules=resolve(import.meta.dirname,'../build-tools/node_modules');
export function flutterBuildRequire(peerModules=flutterPeerModules){
  return createRequire(join(dirname(resolve(peerModules)),'package.json'));
}
export function configuredFlutterPeerModules(){
  return process.env.TBC_FLUTTER_PEER_MODULES || flutterPeerModules;
}
