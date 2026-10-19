import {execFileSync} from 'node:child_process';
import {openSync,closeSync,writeFileSync} from 'node:fs';
import {join,resolve} from 'node:path';
import assert from 'node:assert/strict';
const [sdk,root,platform]=process.argv.slice(2);assert(['android','ios'].includes(platform));
assert(resolve(root).startsWith('/private/tmp/tbc-matched-size-'));
const java='/Users/alex/Library/Java/JavaVirtualMachines/temurin-17.jdk/Contents/Home';
const results=[];
for(const name of (process.env.SIZE_ONLY?[process.env.SIZE_ONLY]:['baseline','old','latest'])){
 const cwd=join(root,name),log=join(root,`${name}-${platform}.log`),fd=openSync(log,'a');
 const run=(c,a,dir=cwd)=>execFileSync(c,a,{cwd:dir,stdio:['ignore',fd,fd],env:{...process.env,JAVA_HOME:java,COCOAPODS_DISABLE_STATS:'true'}});
 try{
  console.log(`BUILD_START ${name} ${platform}`);
  if(platform==='android')run('./gradlew',['assembleRelease',`-Dorg.gradle.java.home=${java}`,'-Ptarget-platform=android-arm64','-Ptarget=lib/main.dart','-Pdart-obfuscation=false','-Ptrack-widget-creation=true','-Ptree-shake-icons=true','--console=plain','--max-workers=4'],join(cwd,'android'));
  else {
   run(join(sdk,'bin/flutter'),['build','ios','--release','--no-codesign','--config-only','--no-pub']);
   // Size-only local ad-hoc signatures: Xcode device provisioning is disabled,
   // but the immutable plugin still verifies real embedded signature integrity.
   // The SAME phase runs for all variants and does not edit any plugin source.
   run('ruby',['-rxcodeproj','-e',`p=Xcodeproj::Project.open('ios/Runner.xcodeproj');t=p.targets.find{|x|x.name=='Runner'};s=t.shell_script_build_phases.find{|x|x.name=='Size only local framework signing'}||t.new_shell_script_build_phase('Size only local framework signing');s.shell_script='set -e\nfor framework in "$TARGET_BUILD_DIR/$WRAPPER_NAME/Frameworks/"*.framework; do\n  [ -d "$framework" ] || continue\n  /usr/bin/codesign --force --sign - --timestamp=none "$framework"\ndone\n';t.build_phases.delete(s);i=t.build_phases.index{|x|x.respond_to?(:name)&&x.name=='TBC verify embedded native pair'};if i;t.build_phases.insert(i,s);else;t.build_phases<<s;end;p.save`]);
   run('xcodebuild',['-workspace','Runner.xcworkspace','-scheme','Runner','-configuration','Release','-sdk','iphoneos','-destination','generic/platform=iOS','-derivedDataPath',join(cwd,'derived-size-release'),'ARCHS=arm64','ONLY_ACTIVE_ARCH=YES','CODE_SIGNING_ALLOWED=NO','-quiet','build'],join(cwd,'ios'));
   run('/usr/bin/codesign',['--force','--sign','-','--timestamp=none',join(cwd,'derived-size-release/Build/Products/Release-iphoneos/Runner.app')]);
  }
  results.push({name,platform,passed:true,log});console.log(`BUILD_PASS ${name} ${platform}`);
 }catch(e){results.push({name,platform,passed:false,log});console.log(`BUILD_FAIL ${name} ${platform}: ${e.status}`);}finally{closeSync(fd);}
}
writeFileSync(join(root,`build-${platform}${process.env.SIZE_ONLY?'-'+process.env.SIZE_ONLY:''}.json`),JSON.stringify(results,null,2));
if(results.some(r=>!r.passed))process.exitCode=1;
