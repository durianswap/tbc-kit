import assert from 'node:assert/strict';
import {preparePortablePlugin,verifyPortablePlugin} from './portable-plugin.mjs';
const args=process.argv.slice(2);assert.equal(args.length,3,'IOS_CANDIDATE ANDROID_CANDIDATE NEW_OUTPUT');
await preparePortablePlugin(...args);
const manifest=await verifyPortablePlugin(args[2]);
console.log(JSON.stringify({status:manifest.status,out:args[2],files:Object.keys(manifest.files).length,platforms:manifest.platforms}));
