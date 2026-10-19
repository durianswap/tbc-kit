// Build-only comparison of the frozen r5 integration package, not acceptance.
// Usage: node measure-r5-download.mjs /private/tmp/tbc-matched-size-... output.json
import assert from 'node:assert/strict';
import {readFile, writeFile, readdir, mkdir, mkdtemp, cp, stat} from 'node:fs/promises';
import {execFileSync} from 'node:child_process';
import {createHash} from 'node:crypto';
import {join, resolve} from 'node:path';

const [rootArg, outputArg] = process.argv.slice(2);
const root = resolve(rootArg), output = resolve(outputArg);
assert(root.startsWith('/private/tmp/tbc-matched-size-'));
const pkg = join(root, 'incoming/tbc_kit_flutter_dart');
const frozen = {
  zip: {path:'/Users/alex/Downloads/tbc-wallet-integration-r5.zip', sha256:'8af3f5669cc8112988b0f887c6747646c66c26b24bd252c1442347095893a447'},
  runtime: {path:join(root,'incoming/TBC-Wallet-Integration-r5/packages/tbc-kit-flutter.tgz'), sha256:'9231928f6e497ddc103895a8a99c837cade957b1ee8332a72514e6b29e31ab38'},
  previousZip: {path:'/Users/alex/Downloads/tbc-wallet-integration-r4.zip', sha256:'bf90f8f6535a17231194fb4744788ca03faee0a9a7840aa3b25a3e01489958b1'},
};
const sha = b => createHash('sha256').update(b).digest('hex');
const meta = b => ({bytes:b.length, sha256:sha(b)});
const fileMeta = async p => meta(await readFile(p));
const run = (cmd, args, opts={}) => execFileSync(cmd,args,{maxBuffer:128e6,...opts});
const extract = (zip,p) => run('/usr/bin/unzip',['-p',zip,p]);
const names = zip => run('/usr/bin/unzip',['-Z1',zip],{encoding:'utf8'}).trim().split('\n');
async function tree(path,prefix='') {
  const out=[];
  for(const f of await readdir(path,{withFileTypes:true})) {
    if(f.isDirectory())out.push(...await tree(join(path,f.name),join(prefix,f.name)));
    else if(f.isFile())out.push({name:join(prefix,f.name),...await fileMeta(join(path,f.name))});
  }
  return out;
}
function zipEntries(path) {
  return run('/usr/bin/unzip',['-lv',path],{encoding:'utf8'}).split('\n').flatMap(line=>{
    const m=line.match(/^\s*(\d+)\s+(Stored|Defl:\S+)\s+(\d+)\s+\S+\s+\S+\s+\S+\s+[a-f\d]+\s+(.+)$/i);
    return m?[{name:m[4],bytes:Number(m[1]),compressedBytes:Number(m[3])}]:[];
  });
}
for(const item of Object.values(frozen)) {
  const actual=await fileMeta(item.path);assert.equal(actual.sha256,item.sha256,item.path);
  item.bytes=actual.bytes;
}
const inventory=JSON.parse(await readFile(join(pkg,'package-files.json'),'utf8'));
for(const [p,h]of Object.entries(inventory.files))assert.equal(sha(await readFile(join(pkg,p))),h,p);
const packagePaths=(await tree(pkg)).map(f=>f.name).filter(p=>p!=='package-files.json').sort();
assert.deepEqual(packagePaths,Object.keys(inventory.files).sort(),'Unexpected/missing package files');
const distribution=JSON.parse(await readFile(join(pkg,'distribution.json'),'utf8'));
const packageVersion=(await readFile(join(pkg,'pubspec.yaml'),'utf8')).match(/^version:\s*(.+)$/m)?.[1];
assert.equal(packageVersion,'0.0.0-partner.20261016.7');
const variants={};
for(const name of ['baseline','latest']) {
  for(const platform of ['android','ios']) {
    const build=JSON.parse(await readFile(join(root,`build-${platform}-${name}.json`),'utf8'));
    assert.equal(build.length,1);assert.equal(build[0].passed,true);
  }
  const path=join(root,name);
  const apk=join(path,'build/app/outputs/apk/release/app-release.apk');
  const app=join(path,'derived-size-release/Build/Products/Release-iphoneos/Runner.app');
  const entries=names(apk), archiveEntries=zipEntries(apk);
  assert.equal(entries.length,archiveEntries.length);
  assert(entries.filter(p=>p.startsWith('lib/')).every(p=>p.startsWith('lib/arm64-v8a/')));
  const native=Object.fromEntries(entries.filter(p=>/^lib\/.*\.so$/.test(p)).map(p=>[p,meta(extract(apk,p))]));
  const iosFiles=await tree(app);
  for(const binary of ['Runner','Frameworks/Flutter.framework/Flutter','Frameworks/App.framework/App']) {
    assert.equal(run('/usr/bin/lipo',['-archs',join(app,binary)],{encoding:'utf8'}).trim(),'arm64');
  }
  run('/usr/bin/codesign',['--verify','--deep','--strict',app]);
  run('/usr/bin/unzip',['-tq',apk]);
  if(name==='baseline') {
    assert(!entries.some(p=>/tbc|hermes|\.hbc$/i.test(p)));
    assert(!iosFiles.some(p=>/tbc|hermes|\.hbc$/i.test(p.name)));
  }else{
    assert(!entries.some(p=>/hermes|\.hbc$/.test(p)));
    assert(!iosFiles.some(p=>/hermes|\.hbc$/.test(p.name)));
    const page=await readFile(join(pkg,'android/src/main/assets/tbc-kit/tbc-webview-page.js'));
    assert.equal(sha(extract(apk,'assets/tbc-kit/tbc-webview-page.js')),sha(page));
    const iosPage=iosFiles.find(p=>p.name.endsWith('tbc-webview-page.js'));assert(iosPage);
    assert.equal(iosPage.sha256,sha(page));
    for(const file of ['libtbc_compute_native.so','libtbc_signer_kernel.so','libtbc_dart_reviewed.so']) {
      assert.equal(native['lib/arm64-v8a/'+file].sha256,sha(await readFile(join(pkg,'android/src/main/jniLibs/arm64-v8a',file))));
    }
    for(const file of ['TbcFlutterEngine','TbcFlutterSigner']) {
      assert(iosFiles.some(p=>p.name===`Frameworks/${file}.framework/${file}`));
      assert.equal(run('/usr/bin/lipo',['-archs',join(app,`Frameworks/${file}.framework/${file}`)],{encoding:'utf8'}).trim(),'arm64');
    }
    const symbols=run('/usr/bin/nm',['-g',join(app,'Runner')],{encoding:'utf8'});
    assert(symbols.includes('TbcPartnerWalletHost'),'iOS native host stripped');
    for(const aot of [extract(apk,'lib/arm64-v8a/libapp.so'),await readFile(join(app,'Frameworks/App.framework/App'))]) {
      const s=aot.toString('latin1');
      for(const marker of ['tbc-amm','tbc_signMessage','tbc_signTransaction','legacy-window-turing','Enable native wallet access'])assert(s.includes(marker),`Missing AOT path ${marker}`);
    }
    assert.equal(sha(await readFile(join(path,'lib/partner_wallet_page.dart'))),inventory.files['example/lib/partner_wallet_page.dart']);
    assert.equal(sha(await readFile(join(path,'lib/partner_browser.dart'))),inventory.files['example/lib/partner_browser.dart']);
  }
  // Exact same local IPA packaging for both device Release Apps. Never export
  // an unsigned local size archive as an App Store download or installable IPA.
  const staging=await mkdtemp(join(root,`ipa-${name}-`));await mkdir(join(staging,'Payload'),{recursive:false});
  await cp(app,join(staging,'Payload/Runner.app'),{recursive:true});
  const ipa=join(staging,`${name}-local-size.ipa`);
  try {await stat(ipa);throw new Error('Refusing to overwrite existing IPA');}
  catch(e){if(e.code!=='ENOENT')throw e;}
  run('/usr/bin/zip',['-q','-r','-9','-X',ipa,'Payload'],{cwd:staging});
  run('/usr/bin/unzip',['-tq',ipa]);
  variants[name]={
    source:{main:await fileMeta(join(path,'lib/main.dart')),gradle:await fileMeta(join(path,'android/app/build.gradle.kts')),pubspecLock:await fileMeta(join(path,'pubspec.lock'))},
    android:{path:apk,...await fileMeta(apk),native,zipEntries:archiveEntries},
    ios:{path:ipa,...await fileMeta(ipa),app,uncompressedLogicalBytes:iosFiles.reduce((s,f)=>s+f.bytes,0),files:iosFiles,zipEntries:zipEntries(ipa)},
  };
}
assert.deepEqual(variants.latest.source.main,variants.baseline.source.main);
assert.deepEqual(variants.latest.source.gradle,variants.baseline.source.gradle);
assert.deepEqual(variants.latest.android.native['lib/arm64-v8a/libflutter.so'],variants.baseline.android.native['lib/arm64-v8a/libflutter.so']);
assert.equal(variants.latest.ios.files.find(p=>p.name==='Frameworks/Flutter.framework/Flutter').sha256,variants.baseline.ios.files.find(p=>p.name==='Frameworks/Flutter.framework/Flutter').sha256);
const comparison=Object.fromEntries(['android','ios'].map(platform=>{
  const baseline=variants.baseline[platform].bytes,full=variants.latest[platform].bytes,delta=full-baseline;
  return [platform,{baselineBytes:baseline,r5FullAppBytes:full,incrementBytes:delta,incrementMB:delta/1e6,incrementMiB:delta/1048576}];
}));
const report={status:'R5_MATCHED_RELEASE_DOWNLOAD_SIZE_PASS',recordedAt:new Date().toISOString(),
  root,frozen,packageVersion,kitIdentity:distribution.kitIdentity,inventoryFilesVerified:Object.keys(inventory.files).length,
  inventorySha256:sha(await readFile(join(pkg,'package-files.json'))),comparison,variants,
  methodology:[
    'Actual runtime extracted from r5 ZIP. Frozen r5 and r4 ZIPs and runtime are SHA256-verified; all 181 payload files verified.',
    'Flutter 3.29.3, Dart 3.7.2, WebView 6.1.5; matched two-route integration host; Release arm64; API26/target36 and iOS15.0.',
    'Baseline: Flutter/WebView without Kit. r5: full dynamic Standard/Legacy dispatcher, unmodified browser and native wallet page examples, full native host retained.',
    'Android: signed arm64 APK, R8/resource shrinking on and native ZIP compression on. Exact bytes for these APKs; Play-generated split download may differ.',
    'iOS: iphoneos Release arm64, identical local ad-hoc signatures, ZIP -9 -X Payload/Runner.app. Local compressed IPA comparison, NOT App Store encrypted/thinned download measurement.',
    'Neither platform is the partner production app. Existing dependency overlap, partner UI/Vault glue and store processing change final increments.',
    'Build and artifact retention/integrity only. No functional tests, no new timing claim, no funds, signing or broadcasts. No delivery-package mutation.',
  ],broadcasts:0};
await writeFile(output,JSON.stringify(report,null,2)+'\n',{flag:'wx'});
console.log(JSON.stringify({status:report.status,comparison,output},null,2));
