#include <jni.h>
#include "reviewed_compute.h"
extern "C" JNIEXPORT jstring JNICALL Java_io_tbc_kit_dart_ReviewedRustAbi_identity(JNIEnv *env, jobject) {
  return env->NewStringUTF(tbc_dart_reviewed_identity());
}
extern "C" JNIEXPORT jbyteArray JNICALL Java_io_tbc_kit_dart_ReviewedRustAbi_call(JNIEnv *env, jobject, jbyteArray method, jbyteArray input) {
  jbyte *m=nullptr,*i=nullptr;jbyteArray result=nullptr;
  TbcDartReviewedOutput output{};
  if (method && input) {
    const auto ml=env->GetArrayLength(method),il=env->GetArrayLength(input);
    if (ml>=0 && ml<=32 && il>=0 && il<=16*1024*1024) {
      m=env->GetByteArrayElements(method,nullptr);
      if (m) i=env->GetByteArrayElements(input,nullptr);
      if (m && i && tbc_dart_reviewed_call(reinterpret_cast<uint8_t*>(m),ml,
          reinterpret_cast<uint8_t*>(i),il,&output)==0) {
        result=env->NewByteArray(static_cast<jsize>(output.len));
        if (result && output.len) env->SetByteArrayRegion(result,0,static_cast<jsize>(output.len),reinterpret_cast<jbyte*>(output.ptr));
      }
    }
  }
  if (i) env->ReleaseByteArrayElements(input,i,JNI_ABORT);
  if (m) env->ReleaseByteArrayElements(method,m,JNI_ABORT);
  tbc_dart_reviewed_free(output);
  if (!result && !env->ExceptionCheck()) env->ThrowNew(env->FindClass("java/lang/IllegalStateException"),"NATIVE_REVIEWED_COMPUTE_FAILED");
  return result;
}
