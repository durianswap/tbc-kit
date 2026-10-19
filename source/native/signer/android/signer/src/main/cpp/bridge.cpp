#include <jni.h>
#include <array>
#include <vector>
#include "tbc_signer_kernel.h"

namespace {
struct Scalar {
  std::array<uint8_t, 32> bytes{};
  ~Scalar() { volatile uint8_t* p = bytes.data(); for (size_t i = 0; i < bytes.size(); ++i) p[i] = 0; }
};
void fail(JNIEnv* env, const char* type, const char* message) {
  if (env->ExceptionCheck()) return;
  auto clazz = env->FindClass(type);
  if (clazz) { env->ThrowNew(clazz, message); env->DeleteLocalRef(clazz); }
}
}
extern "C" JNIEXPORT jbyteArray JNICALL Java_io_tbc_signer_TbcDigestSigner_cryptNative(
    JNIEnv* env, jobject, jbyteArray input, jbyteArray scalar, jboolean decrypt) {
  if (!input || !scalar || env->GetArrayLength(scalar) != 32) {
    fail(env,"java/lang/IllegalArgumentException","Invalid crypto input"); return nullptr;
  }
  const auto length=env->GetArrayLength(input), capacity=decrypt?length:length+85;
  if(length<0 || capacity<=0 || capacity>1048661) { fail(env,"java/lang/IllegalArgumentException","Invalid crypto size");return nullptr; }
  Scalar key;
  struct Bytes { std::vector<uint8_t> v; ~Bytes(){volatile uint8_t* p=v.data();for(size_t i=0;i<v.size();++i)p[i]=0;} };
  Bytes source{std::vector<uint8_t>(length?length:1)}, target{std::vector<uint8_t>(capacity)};
  env->GetByteArrayRegion(scalar,0,32,reinterpret_cast<jbyte*>(key.bytes.data()));
  env->GetByteArrayRegion(input,0,length,reinterpret_cast<jbyte*>(source.v.data()));
  if(env->ExceptionCheck())return nullptr;
  const auto result=tbc_signer_bie1(source.v.data(),length,key.bytes.data(),32,decrypt?1:0,target.v.data(),capacity);
  if(result<0 || result>capacity){fail(env,"java/lang/IllegalArgumentException","Crypto rejected input");return nullptr;}
  auto output=env->NewByteArray(result);if(!output)return nullptr;
  env->SetByteArrayRegion(output,0,result,reinterpret_cast<const jbyte*>(target.v.data()));
  return env->ExceptionCheck()?nullptr:output;
}
extern "C" JNIEXPORT jbyteArray JNICALL Java_io_tbc_signer_TbcDigestSigner_signNative(
    JNIEnv* env, jobject, jbyteArray digest, jbyteArray scalar, jint encoding) {
  if (tbc_signer_kernel_version() != 1) {
    fail(env, "java/lang/IllegalStateException", "Incompatible signer ABI"); return nullptr;
  }
  if (!digest || !scalar || env->GetArrayLength(digest) != 32 || env->GetArrayLength(scalar) != 32 || (encoding != 64 && encoding != 65 && encoding != 164)) {
    fail(env, "java/lang/IllegalArgumentException", "Invalid signer input"); return nullptr;
  }
  Scalar key; std::array<uint8_t, 32> d{}; std::array<uint8_t, 65> output{};
  env->GetByteArrayRegion(digest, 0, 32, reinterpret_cast<jbyte*>(d.data()));
  if (env->ExceptionCheck()) return nullptr;
  env->GetByteArrayRegion(scalar, 0, 32, reinterpret_cast<jbyte*>(key.bytes.data()));
  if (env->ExceptionCheck()) return nullptr;
  const auto size = encoding == 164 ? 64 : encoding;
  const auto status = tbc_signer_sign_digest(d.data(), 32, key.bytes.data(), 32, encoding, output.data(), size);
  if (status != 0) { fail(env, "java/lang/IllegalArgumentException", "Signer rejected input"); return nullptr; }
  auto result = env->NewByteArray(size);
  if (!result) return nullptr;
  env->SetByteArrayRegion(result, 0, size, reinterpret_cast<const jbyte*>(output.data()));
  return env->ExceptionCheck() ? nullptr : result;
}
