Pod::Spec.new do |s|
  s.name = 'TbcKitEngine'
  s.version = '0.0.0'
  s.summary = 'Keyless TBC Kit Engine Expo bridge'
  s.description = 'Expo glue consuming the verified standalone TBC Engine SDK sources and binaries.'
  s.license = { :type => 'CC0-1.0' }
  s.author = 'TBC Kit contributors'
  s.homepage = 'https://docs.turingbitchain.io'
  s.source = { :http => 'https://docs.turingbitchain.io' }
  # Candidate178 rebuilds every Rust/C member and audits the minimum OS.
  s.platforms = { :ios => '15.1' }
  s.swift_version = '5.9'
  s.static_framework = true
  s.dependency 'ExpoModulesCore'
  s.source_files = 'ios/**/*.swift', 'platform-sdk/apple/Sources/TbcEngine/*.swift'
  s.vendored_frameworks = 'platform-sdk/apple/Artifacts/TbcEngineNative.xcframework',
                          'platform-sdk/apple/Artifacts/TbcKeylessNative.xcframework'
  # CocoaPods copies static XCFramework Headers into one per-pod directory;
  # the second archive's Headers may replace the first. Import each immutable
  # source slice directly instead of merging or rewriting SDK module maps.
  sdk_artifacts = '${PODS_TARGET_SRCROOT}/platform-sdk/apple/Artifacts'
  slice_headers = lambda do |slice|
    ['TbcEngineNative', 'TbcKeylessNative'].map { |name|
      "\"#{sdk_artifacts}/#{name}.xcframework/#{slice}/Headers\""
    }.join(' ')
  end
  s.pod_target_xcconfig = {
    'DEFINES_MODULE' => 'YES',
    'SWIFT_INCLUDE_PATHS[sdk=iphonesimulator*]' => "$(inherited) #{slice_headers.call('ios-arm64-simulator')}",
    'SWIFT_INCLUDE_PATHS[sdk=iphoneos*]' => "$(inherited) #{slice_headers.call('ios-arm64')}"
  }
  s.script_phase = {
    :name => 'Verify TBC Kit native artifacts',
    :execution_position => :before_compile,
    :script => '"${NODE_BINARY:-node}" "$PODS_TARGET_SRCROOT/scripts/sync-native.mjs" --check --platform ios'
  }
end
