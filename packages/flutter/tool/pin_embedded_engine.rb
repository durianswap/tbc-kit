# Build-time only. Run after [CP] Embed Pods Frameworks, before final App signing.
# Compare code-signed frameworks with the immutable package. Only Apple's code
# signature metadata may differ. Runtime keeps its exact full-file hash check.
require 'json'
require 'digest'
require 'fileutils'
require 'tmpdir'
require 'open3'

def run(*args)
  output, status = Open3.capture2e(*args)
  raise "Native signing comparison failed: #{args.first}" unless status.success?
  output
end

plugin = File.expand_path('..', __dir__)
manifest = JSON.parse(File.read(File.join(plugin, 'distribution.json')))
platform = ENV.fetch('PLATFORM_NAME')
slice = {'iphoneos'=>'ios-arm64', 'iphonesimulator'=>'ios-arm64-simulator'}.fetch(platform)
raise 'Only arm64 is shipped' unless ENV.fetch('ARCHS').split == ['arm64']
app = File.join(ENV.fetch('TARGET_BUILD_DIR'), ENV.fetch('WRAPPER_NAME'))
pins = {'artifactId'=>manifest.fetch('artifactId')}
%w[TbcFlutterEngine TbcFlutterSigner].each do |name|
  relative = "ios/Frameworks/#{name}.xcframework/#{slice}/#{name}.framework/#{name}"
  source = File.join(plugin, relative)
  target = File.join(app, 'Frameworks', "#{name}.framework", name)
  raise 'Package native binary changed' unless Digest::SHA256.file(source).hexdigest == manifest.fetch('nativeArtifacts').fetch(relative)
  run('codesign', '--verify', '--strict', File.dirname(target))
  normalized = Dir.mktmpdir('tbc-package-signing-') do |tmp|
    [source, target].each_with_index.map do |path, index|
      copy = File.join(tmp, index.to_s)
      FileUtils.cp(path, copy)
      run('codesign', '--remove-signature', copy)
      run('codesign', '--force', '--sign', '-', '--identifier', "io.tbc.paired.#{name}", '--timestamp=none', copy)
      Digest::SHA256.file(copy).hexdigest
    end
  end
  raise 'Embedded native implementation does not match package' unless normalized[0] == normalized[1]
  pins[name == 'TbcFlutterEngine' ? 'engineSha256' : 'signerSha256'] = Digest::SHA256.file(target).hexdigest
end
File.write(File.join(app, 'tbc-dart-native-pins.json'), JSON.generate(pins))
puts 'TBC embedded native pair verified and pinned'
