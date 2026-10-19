// Optional wallet-private JNI. Secret nonce remains in the Rust registry.
#include <jni.h>
#include <array>
#include <cstdio>
#include "tbc_signer_musig.h"

namespace {
void fail(JNIEnv* env, int status) {
  if (env->ExceptionCheck()) return;
  char message[48]; std::snprintf(message, sizeof(message), "MuSig rejected: %d", status);
  auto type = env->FindClass("java/lang/IllegalArgumentException");
  if (type) { env->ThrowNew(type, message); env->DeleteLocalRef(type); }
}
struct Scratch {
  uint8_t* p = tbc_signer_musig_buffer_new();
  ~Scratch() { if (p) tbc_signer_musig_buffer_free(p); }
};
struct Burn {
  const uint8_t* handle = nullptr;
  ~Burn() { if (handle) tbc_signer_musig_cancel(handle); }
};
bool read(JNIEnv* env, jbyteArray value, size_t size, uint8_t* out) {
  if (!value || env->GetArrayLength(value) != static_cast<jsize>(size)) { fail(env, 100); return false; }
  env->GetByteArrayRegion(value, 0, size, reinterpret_cast<jbyte*>(out));
  return !env->ExceptionCheck();
}
int participants(JNIEnv* env, jbyteArray value, int width) {
  if (!value) { fail(env, 100); return 0; }
  int size = env->GetArrayLength(value), count = size / width;
  if (count < 2 || count > 32 || size % width) { fail(env, 100); return 0; }
  return count;
}
jbyteArray output(JNIEnv* env, uint8_t* bytes, size_t size) {
  auto result = env->NewByteArray(size);
  if (result) env->SetByteArrayRegion(result, 0, size, reinterpret_cast<jbyte*>(bytes));
  return env->ExceptionCheck() ? nullptr : result;
}
}

extern "C" JNIEXPORT jint JNICALL Java_io_tbc_signer_MuSigNative_version(JNIEnv*, jobject) {
  return tbc_signer_musig_version();
}
extern "C" JNIEXPORT jbyteArray JNICALL Java_io_tbc_signer_MuSigNative_aggregateKey(JNIEnv* env, jobject, jbyteArray keys) {
  const auto n = participants(env, keys, 33); if (!n) return nullptr;
  Scratch s; if (!s.p) { fail(env, 109); return nullptr; }
  if (!read(env, keys, n * 33, s.p)) return nullptr;
  const auto status = tbc_signer_musig_aggregate_key(s.p, n, s.p + 1056);
  if (status) { fail(env, status); return nullptr; }
  return output(env, s.p + 1056, 32);
}
extern "C" JNIEXPORT jbyteArray JNICALL Java_io_tbc_signer_MuSigNative_begin(
    JNIEnv* env, jobject, jbyteArray keys, jbyteArray aggregate, jbyteArray digest,
    jbyteArray binding, jbyteArray scalar, jbyteArray entropy, jlong now, jlong expires) {
  Scratch s; if (!s.p) { fail(env, 109); return nullptr; }
  const auto n = participants(env, keys, 33);
  if (!n || now < 0 || expires < 0) { fail(env, 100); return nullptr; }
  if (!read(env, keys, n * 33, s.p) || !read(env, aggregate, 32, s.p + 1056) ||
      !read(env, digest, 32, s.p + 1088) || !read(env, binding, 32, s.p + 1120) ||
      !read(env, scalar, 32, s.p + 1152) || !read(env, entropy, 32, s.p + 1184)) return nullptr;
  // Caller also clears entropy in finally; erase its JNI-visible buffer before use.
  std::array<jbyte, 32> zero{}; env->SetByteArrayRegion(entropy, 0, 32, zero.data());
  if (env->ExceptionCheck()) return nullptr;
  const auto status = tbc_signer_musig_begin(s.p, n, s.p + 1056, s.p + 1088, s.p + 1120,
      s.p + 1152, s.p + 1184, now, expires, s.p + 1216, s.p + 1248);
  if (status) { fail(env, status); return nullptr; }
  Burn guard{s.p + 1216}; // Cancel if JVM allocation/copy fails after native begin.
  auto result = output(env, s.p + 1216, 98);
  if (result) guard.handle = nullptr;
  return result;
}
extern "C" JNIEXPORT jbyteArray JNICALL Java_io_tbc_signer_MuSigNative_sign(
    JNIEnv* env, jobject, jbyteArray handle, jbyteArray binding, jbyteArray digest,
    jbyteArray scalar, jbyteArray nonces, jlong now) {
  // Read handle before scratch allocation/validation so recognizable sessions
  // are consumed even on JNI failure. Handle is public, not a secret nonce.
  std::array<uint8_t, 32> h{};
  if (!read(env, handle, 32, h.data())) return nullptr;
  Burn guard{h.data()};
  Scratch s; if (!s.p) { fail(env, 109); return nullptr; }
  const auto n = participants(env, nonces, 66);
  if (!n || now < 0) { fail(env, 100); return nullptr; }
  if (!read(env, binding, 32, s.p + 1120) || !read(env, digest, 32, s.p + 1088) ||
      !read(env, scalar, 32, s.p + 1152) || !read(env, nonces, n * 66, s.p + 1314)) return nullptr;
  const auto status = tbc_signer_musig_sign(h.data(), s.p + 1120, s.p + 1088, s.p + 1152,
      s.p + 1314, n, now, s.p + 3426);
  if (status) { fail(env, status); return nullptr; }
  return output(env, s.p + 3426, 32);
}
extern "C" JNIEXPORT void JNICALL Java_io_tbc_signer_MuSigNative_cancel(JNIEnv* env, jobject, jbyteArray handle) {
  std::array<uint8_t, 32> h{};
  if (read(env, handle, 32, h.data())) tbc_signer_musig_cancel(h.data());
}
extern "C" JNIEXPORT jbyteArray JNICALL Java_io_tbc_signer_MuSigNative_combine(
    JNIEnv* env, jobject, jbyteArray keys, jbyteArray aggregate, jbyteArray digest,
    jbyteArray nonces, jbyteArray shares) {
  Scratch s; if (!s.p) { fail(env, 109); return nullptr; }
  const auto n = participants(env, keys, 33); if (!n) return nullptr;
  if (!read(env, keys, n * 33, s.p) || !read(env, aggregate, 32, s.p + 1056) ||
      !read(env, digest, 32, s.p + 1088) || !read(env, nonces, n * 66, s.p + 1314) ||
      !read(env, shares, n * 32, s.p + 3426)) return nullptr;
  const auto status = tbc_signer_musig_combine(s.p, n, s.p + 1056, s.p + 1088, s.p + 1314, s.p + 3426, s.p + 4450);
  if (status) { fail(env, status); return nullptr; }
  return output(env, s.p + 4450, 64);
}
