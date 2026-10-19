#include <jni.h>
#include <limits>
#include <new>
#include <vector>
#include "tbc_engine.h"

namespace {
void fail(JNIEnv *env, const char *message) {
  jclass type = env->FindClass("java/lang/IllegalStateException");
  if (type) env->ThrowNew(type, message);
}
struct OwnedBuffer {
  TbcEngineBuffer value;
  ~OwnedBuffer() { tbc_engine_free(value); }
};
}

// Same byte-array ABI and RAII release as the accepted Expo bridge; only the
// owner namespace/library changes. No modified UTF-8, keys or business routing.
extern "C" JNIEXPORT jbyteArray JNICALL
Java_io_tbc_engine_TbcEngineNativeBridge_callNative(
    JNIEnv *env, jclass, jbyteArray method, jbyteArray input) {
  if (!method || !input) { fail(env, "Missing Engine input"); return nullptr; }
  try {
    std::vector<uint8_t> methodBytes(env->GetArrayLength(method));
    std::vector<uint8_t> inputBytes(env->GetArrayLength(input));
    if (!methodBytes.empty()) env->GetByteArrayRegion(method, 0, methodBytes.size(), reinterpret_cast<jbyte *>(methodBytes.data()));
    if (env->ExceptionCheck()) return nullptr;
    if (!inputBytes.empty()) env->GetByteArrayRegion(input, 0, inputBytes.size(), reinterpret_cast<jbyte *>(inputBytes.data()));
    if (env->ExceptionCheck()) return nullptr;
    OwnedBuffer buffer{tbc_engine_call(methodBytes.data(), methodBytes.size(), inputBytes.data(), inputBytes.size())};
    const auto &value = buffer.value;
    if (value.len > value.cap || (!value.ptr && value.len) || value.len > static_cast<size_t>(std::numeric_limits<jsize>::max())) {
      fail(env, "Invalid Engine output buffer"); return nullptr;
    }
    jbyteArray result = env->NewByteArray(static_cast<jsize>(value.len));
    if (result && value.len) env->SetByteArrayRegion(result, 0, static_cast<jsize>(value.len), reinterpret_cast<const jbyte *>(value.ptr));
    return result;
  } catch (const std::bad_alloc &) {
    fail(env, "Engine bridge allocation failed"); return nullptr;
  } catch (...) {
    fail(env, "Engine bridge failed"); return nullptr;
  }
}
