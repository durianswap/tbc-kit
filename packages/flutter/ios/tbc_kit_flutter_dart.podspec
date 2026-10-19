Pod::Spec.new do |s|
 s.name='tbc_kit_flutter_dart'
 s.version='0.0.1'
 s.summary='TBC Dart orchestration and paired native custody integration'
 s.homepage='https://turingbitchain.io'
 s.license={:type=>'CC0-1.0',:file=>'../LICENSE'}
 s.author='TBC'
 s.source={:path=>'.'}
 s.platform=:ios,'15.0'
 s.dependency 'Flutter'
 s.swift_version='5.0'
 s.static_framework=true
 s.source_files='Classes/**/*.swift','Reviewed/*.{cpp,h}'
 s.public_header_files='Reviewed/reviewed_compute.h'
 s.resource_bundles={'TbcDartKit'=>['Resources/*']}
 s.vendored_frameworks='Frameworks/TbcFlutterEngine.xcframework','Frameworks/TbcFlutterSigner.xcframework'
 s.libraries='sqlite3'
 s.pod_target_xcconfig={'DEFINES_MODULE'=>'YES','CLANG_CXX_LANGUAGE_STANDARD'=>'c++17','OTHER_CPLUSPLUSFLAGS'=>'$(inherited) -fno-exceptions -fno-rtti','EXCLUDED_ARCHS[sdk=iphonesimulator*]'=>'i386 x86_64'}
end
