cmake_minimum_required(VERSION 3.22.1)
project(tbc_engine_jni LANGUAGES CXX)
add_library(tbc_engine_native SHARED IMPORTED)
set_target_properties(tbc_engine_native PROPERTIES
  IMPORTED_LOCATION "${CMAKE_CURRENT_LIST_DIR}/../jniLibs/${ANDROID_ABI}/libtbc_engine_native.so"
  IMPORTED_NO_SONAME TRUE)
add_library(tbc_engine_jni SHARED bridge.cpp)
target_include_directories(tbc_engine_jni PRIVATE include)
target_compile_features(tbc_engine_jni PRIVATE cxx_std_17)
target_link_libraries(tbc_engine_jni PRIVATE tbc_engine_native)
target_link_options(tbc_engine_jni PRIVATE "-Wl,-z,max-page-size=16384")
