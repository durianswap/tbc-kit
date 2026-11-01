import {readFile,writeFile,mkdir,copyFile} from 'node:fs/promises';
import {execFileSync} from 'node:child_process';
import {resolve,join} from 'node:path';
const root=resolve(import.meta.dirname,'../../..'),out=join(root,'.verify/rc23-device-app'),sdk=join(root,'.verify/rc23-native/sdk');
const run=(cmd,args,extra={})=>execFileSync(cmd,args,{cwd:out,stdio:'inherit',timeout:180000,...extra});
const mode=process.argv[2];
if(mode==='ios'){
 const app=join(out,'Rc23Probe.app');await mkdir(app,{recursive:true});for(const f of ['index.html','suite.js'])await copyFile(join(out,f),join(app,f));
 const slice=join(sdk,'apple/Artifacts/TbcEngineNative.xcframework/ios-arm64-simulator'),keyless=join(sdk,'apple/Artifacts/TbcKeylessNative.xcframework/ios-arm64-simulator');
 const platform=execFileSync('xcrun',['--sdk','iphonesimulator','--show-sdk-path'],{encoding:'utf8'}).trim();
 run('xcrun',['swiftc','-swift-version','5','-O','-parse-as-library','-target','arm64-apple-ios15.1-simulator','-sdk',platform,
 ...['TbcEngine.swift','TbcEngineIdentity.swift','TbcKeylessEngine.swift'].map(f=>join(sdk,'apple/Sources/TbcEngine',f)),join(import.meta.dirname,'Probe.swift'),
 '-I',join(slice,'Headers'),'-I',join(keyless,'Headers'),'-L',slice,'-L',keyless,'-ltbc_engine_native','-ltbc_keyless_native','-framework','UIKit','-framework','WebKit','-o',join(app,'Rc23Probe')]);
 await writeFile(join(app,'Info.plist'),`<?xml version="1.0" encoding="UTF-8"?><!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd"><plist version="1.0"><dict><key>CFBundleIdentifier</key><string>io.tbc.rc23.acceptance</string><key>CFBundleExecutable</key><string>Rc23Probe</string><key>CFBundleName</key><string>RC23 Targeted Probe</string><key>CFBundleVersion</key><string>1</string><key>CFBundleShortVersionString</key><string>0.1.0</string><key>CFBundlePackageType</key><string>APPL</string><key>MinimumOSVersion</key><string>15.1</string><key>UIDeviceFamily</key><array><integer>1</integer></array><key>UILaunchScreen</key><dict/><key>UIRequiredDeviceCapabilities</key><array><string>arm64</string></array></dict></plist>`);
 run('codesign',['--force','--sign','-',app]);
}else if(mode==='android'){
 const project=join(out,'android');await mkdir(join(project,'src/main/java/io/tbc/rc23/acceptance'),{recursive:true});await mkdir(join(project,'src/main/assets'),{recursive:true});
 await copyFile(join(import.meta.dirname,'MainActivity.kt'),join(project,'src/main/java/io/tbc/rc23/acceptance/MainActivity.kt'));for(const f of ['index.html','suite.js'])await copyFile(join(out,f),join(project,'src/main/assets',f));
 await writeFile(join(project,'settings.gradle'),`pluginManagement { repositories { google(); mavenCentral(); gradlePluginPortal() } }\ndependencyResolutionManagement { repositories { maven { url=uri('${join(sdk,'maven-repository')}') }; google();mavenCentral() } }\nrootProject.name='rc23-device-probe'\n`);
 await writeFile(join(project,'build.gradle'),`plugins { id 'com.android.application' version '8.11.0';id 'org.jetbrains.kotlin.android' version '2.1.20' }
android { namespace 'io.tbc.rc23.acceptance'; compileSdk 36
 defaultConfig { applicationId 'io.tbc.rc23.acceptance';minSdk 26;targetSdk 36;versionCode 1;versionName '0.1.0';ndk { abiFilters 'arm64-v8a' } }
 compileOptions { sourceCompatibility JavaVersion.VERSION_17;targetCompatibility JavaVersion.VERSION_17 }
 kotlinOptions { jvmTarget='17' }
}
dependencies { implementation 'io.tbc.local:engine:0.1.0-rc.23.native.2'; implementation 'org.jetbrains.kotlinx:kotlinx-coroutines-core:1.9.0' }
`);
 await writeFile(join(project,'gradle.properties'),'org.gradle.jvmargs=-Xmx1024m\norg.gradle.workers.max=2\nandroid.useAndroidX=true\n');
 await writeFile(join(project,'src/main/AndroidManifest.xml'),`<manifest xmlns:android="http://schemas.android.com/apk/res/android"><application android:label="RC23 Targeted Probe" android:theme="@android:style/Theme.Material.Light.NoActionBar" android:allowBackup="false"><activity android:name=".MainActivity" android:exported="true"><intent-filter><action android:name="android.intent.action.MAIN"/><category android:name="android.intent.category.LAUNCHER"/></intent-filter></activity></application></manifest>`);
 run('/Users/alex/.gradle/wrapper/dists/gradle-8.14.3-bin/cv11ve7ro1n3o1j4so8xd9n66/gradle-8.14.3/bin/gradle',['assembleDebug','--offline','--no-daemon','--console=plain'],{cwd:project,env:{...process.env,JAVA_HOME:'/Users/alex/Library/Java/JavaVirtualMachines/temurin-17.jdk/Contents/Home',ANDROID_HOME:'/Users/alex/Library/Android/sdk'}});
}else throw Error('Specify ios or android');
