#include <jni.h>
#include <limits>
#include <new>
#include <vector>
#include "tbc_keyless.h"
namespace {
void fail(JNIEnv *env, const char *message) {
  jclass type = env->FindClass("java/lang/IllegalStateException");
  if (type) env->ThrowNew(type, message);
}
struct OwnedBuffer { TbcKeylessBuffer value; ~OwnedBuffer() { tbc_keyless_free(value); } };
}
extern "C" JNIEXPORT jbyteArray JNICALL
Java_io_tbc_engine_TbcKeylessNativeBridge_callNative(JNIEnv *env, jclass, jbyteArray operation, jbyteArray input) {
  if (!operation || !input) { fail(env, "Missing keyless input"); return nullptr; }
  try {
    std::vector<uint8_t> name(env->GetArrayLength(operation)), bytes(env->GetArrayLength(input));
    if (!name.empty()) env->GetByteArrayRegion(operation, 0, name.size(), reinterpret_cast<jbyte *>(name.data()));
    if (env->ExceptionCheck()) return nullptr;
    if (!bytes.empty()) env->GetByteArrayRegion(input, 0, bytes.size(), reinterpret_cast<jbyte *>(bytes.data()));
    if (env->ExceptionCheck()) return nullptr;
    OwnedBuffer buffer{tbc_keyless_call(name.data(), name.size(), bytes.data(), bytes.size())};
    const auto &v = buffer.value;
    if (v.len > v.cap || (!v.ptr && v.len) || v.len > static_cast<size_t>(std::numeric_limits<jsize>::max())) {
      fail(env, "Invalid keyless output buffer"); return nullptr;
    }
    jbyteArray result = env->NewByteArray(static_cast<jsize>(v.len));
    if (result && v.len) env->SetByteArrayRegion(result, 0, static_cast<jsize>(v.len), reinterpret_cast<const jbyte *>(v.ptr));
    return result;
  } catch (const std::bad_alloc &) { fail(env, "Keyless bridge allocation failed"); return nullptr; }
    catch (...) { fail(env, "Keyless bridge failed"); return nullptr; }
}
