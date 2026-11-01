import {readFile,writeFile,mkdir,copyFile} from 'node:fs/promises';
import {execFileSync} from 'node:child_process';
import {resolve,join} from 'node:path';
const root=resolve(import.meta.dirname,'../../..'),out=join(root,'.verify/rc26-profile'),mode=process.argv[2]??'ios-targeted',sdk=join(root,'.verify/rc23-native/sdk');
const app=join(out,mode,'Rc26Probe.app');await mkdir(app,{recursive:true});
await copyFile(join(out,mode,'web-suite.js'),join(app,'suite.js'));
await writeFile(join(app,'index.html'),'<!doctype html><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="default-src \'none\'; script-src \'self\'; connect-src \'none\'"><title>RC26 isolated checks</title><pre id="status">Starting</pre><script src="suite.js"></script>');
const slice=join(sdk,'apple/Artifacts/TbcEngineNative.xcframework/ios-arm64-simulator'),keyless=join(sdk,'apple/Artifacts/TbcKeylessNative.xcframework/ios-arm64-simulator');
const platform=execFileSync('xcrun',['--sdk','iphonesimulator','--show-sdk-path'],{encoding:'utf8'}).trim();
execFileSync('xcrun',['swiftc','-swift-version','5','-O','-parse-as-library','-target','arm64-apple-ios15.1-simulator','-sdk',platform,
 ...['TbcEngine.swift','TbcEngineIdentity.swift','TbcKeylessEngine.swift'].map(f=>join(sdk,'apple/Sources/TbcEngine',f)),join(import.meta.dirname,'Probe.swift'),join(root,'source/native/runtime-support/NativeSessionFence.swift'),
 '-I',join(slice,'Headers'),'-I',join(keyless,'Headers'),'-L',slice,'-L',keyless,'-ltbc_engine_native','-ltbc_keyless_native','-framework','UIKit','-framework','WebKit','-o',join(app,'Rc26Probe')],{stdio:'inherit'});
await writeFile(join(app,'Info.plist'),`<?xml version="1.0"?><plist version="1.0"><dict><key>CFBundleIdentifier</key><string>io.tbc.rc26.acceptance</string><key>CFBundleExecutable</key><string>Rc26Probe</string><key>CFBundleName</key><string>RC26 Targeted Probe</string><key>CFBundleVersion</key><string>1</string><key>CFBundleShortVersionString</key><string>0.1.0</string><key>CFBundlePackageType</key><string>APPL</string><key>MinimumOSVersion</key><string>15.1</string><key>UIDeviceFamily</key><array><integer>1</integer></array><key>UILaunchScreen</key><dict/></dict></plist>`);
execFileSync('codesign',['--force','--sign','-',app],{stdio:'inherit'});console.log(app);
