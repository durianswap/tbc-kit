# One-time integration into the host project; never edits source or signing keys.
require 'xcodeproj'
require 'pathname'
require 'shellwords'
project_path = File.expand_path(ARGV.fetch(0))
project = Xcodeproj::Project.open(project_path)
target = project.targets.find { |t| t.name == (ARGV[1] || 'Runner') }
raise 'Named App target not found' unless target && target.product_type == 'com.apple.product-type.application'
name = 'TBC verify embedded native pair'
phase = target.shell_script_build_phases.find { |p| p.name == name } || target.new_shell_script_build_phase(name)
script = Pathname.new(File.join(__dir__, 'pin_embedded_engine.rb')).relative_path_from(Pathname.new(File.dirname(project_path))).to_s
phase.shell_script = "cd \"$SRCROOT\"\n/usr/bin/ruby #{Shellwords.escape(script)}\n"
phase.always_out_of_date = '1'
# CocoaPods keeps its existing embed/copy phases. The pair check must run last.
target.build_phases.delete(phase)
target.build_phases << phase
target.build_configurations.each { |c| c.build_settings['ENABLE_USER_SCRIPT_SANDBOXING'] = 'NO' }
project.save
puts "Installed #{name}; run this again after changing CocoaPods integration"
