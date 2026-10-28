#pragma once
#include <jni.h>
#include <jsi/jsi.h>
#include <cmath>
#include <climits>
#include <cstring>

// Private Hermes only, never installed in a DApp WebView. Same byte-view
// boundary as the existing Flutter native SHA backend: no JSON byte arrays,
// no keys, no network, no signature algorithm change or result cache.
inline void installTbcSha256(facebook::jsi::Runtime& rt, JNIEnv* env) {
  namespace jsi = facebook::jsi;
  rt.global().setProperty(rt, "__tbcNativeSha256", jsi::Function::createFromHostFunction(rt,
    jsi::PropNameID::forAscii(rt,"__tbcNativeSha256"),3,
    [env](jsi::Runtime& r,const jsi::Value&,const jsi::Value* a,size_t n)->jsi::Value {
      if(n!=3||!a[0].isObject()||!a[0].getObject(r).isArrayBuffer(r)||!a[1].isNumber()||!a[2].isNumber())
        throw jsi::JSError(r,"INVALID_HASH_BUFFER");
      auto buffer=a[0].getObject(r).getArrayBuffer(r);
      const double off=a[1].getNumber(),len=a[2].getNumber();
      if(!std::isfinite(off)||!std::isfinite(len)||off<0||len<0||std::floor(off)!=off||std::floor(len)!=len||off>buffer.size(r)||len>buffer.size(r)-off||len>INT_MAX)
        throw jsi::JSError(r,"INVALID_HASH_RANGE");
      if(env->PushLocalFrame(8)<0){env->ExceptionClear();throw jsi::JSError(r,"HASH_ALLOCATION_FAILED");}
      const auto fail=[&](){if(env->ExceptionCheck())env->ExceptionClear();env->PopLocalFrame(nullptr);throw jsi::JSError(r,"NATIVE_SHA256_FAILED");};
      auto cls=env->FindClass("java/security/MessageDigest");if(!cls)fail();
      auto make=env->GetStaticMethodID(cls,"getInstance","(Ljava/lang/String;)Ljava/security/MessageDigest;");if(!make)fail();
      auto digest=env->GetMethodID(cls,"digest","([B)[B");if(!digest)fail();
      auto name=env->NewStringUTF("SHA-256");if(!name)fail();
      auto instance=env->CallStaticObjectMethod(cls,make,name);if(!instance||env->ExceptionCheck())fail();
      auto bytes=env->NewByteArray(static_cast<jsize>(len));if(!bytes)fail();
      if(len)env->SetByteArrayRegion(bytes,0,static_cast<jsize>(len),reinterpret_cast<const jbyte*>(buffer.data(r)+static_cast<size_t>(off)));
      if(env->ExceptionCheck())fail();
      auto value=static_cast<jbyteArray>(env->CallObjectMethod(instance,digest,bytes));
      if(!value||env->ExceptionCheck()||env->GetArrayLength(value)!=32)fail();
      unsigned char output[32];env->GetByteArrayRegion(value,0,32,reinterpret_cast<jbyte*>(output));if(env->ExceptionCheck())fail();
      env->PopLocalFrame(nullptr);
      auto result=r.global().getPropertyAsFunction(r,"Uint8Array").callAsConstructor(r,32).getObject(r);
      auto target=result.getPropertyAsObject(r,"buffer").getArrayBuffer(r);
      if(target.size(r)!=32)throw jsi::JSError(r,"INVALID_HASH_RESULT");
      std::memcpy(target.data(r),output,32);return result;
    }));
}
