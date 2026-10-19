#include "reviewed_build.h"
#include "reviewed_compute.h"
#include <tbc_keyless.h>
#include <stdlib.h>
#include <string.h>
#ifndef TBC_DART_REVIEWED_ARTIFACT
#error Verified Rust artifact identity is required at build time
#endif
extern "C" const char *tbc_dart_reviewed_identity(void) { return TBC_DART_REVIEWED_ARTIFACT; }
extern "C" int tbc_dart_reviewed_call(const uint8_t *method, size_t method_len,
    const uint8_t *input, size_t input_len, TbcDartReviewedOutput *output) {
  if (!output) return 1;
  *output = {nullptr, 0};
  if (!method || method_len > 32 || !input || input_len > 16*1024*1024) return 1;
  const bool prepare=method_len==20 && memcmp(method,"prepareReviewedStage",20)==0;
  const bool finalize=method_len==21 && memcmp(method,"finalizeReviewedStage",21)==0;
  if (!prepare && !finalize) return 1;
  // Rust catches its own panics and returns JSON. No C++ STL, exceptions or
  // extra shared runtime is required in the mobile application.
  const auto result=tbc_keyless_call(method,method_len,input,input_len);
  if (result.len>result.cap || result.len>32*1024*1024 || (result.len && !result.ptr)) {
    tbc_keyless_free(result);return 1;
  }
  auto copy=static_cast<uint8_t*>(malloc(result.len ? result.len : 1));
  if (copy && result.len) memcpy(copy,result.ptr,result.len);
  const auto len=result.len;
  tbc_keyless_free(result);
  if (!copy) return 1;
  *output={copy,len};return 0;
}
extern "C" void tbc_dart_reviewed_free(TbcDartReviewedOutput output) { free(output.ptr); }
