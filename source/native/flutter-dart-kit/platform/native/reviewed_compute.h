#ifndef TBC_DART_REVIEWED_COMPUTE_H
#define TBC_DART_REVIEWED_COMPUTE_H
#include <stddef.h>
#include <stdint.h>
#ifdef __cplusplus
extern "C" {
#endif
typedef struct TbcDartReviewedOutput { uint8_t *ptr; size_t len; } TbcDartReviewedOutput;
// Build provenance only; packaging must independently verify the linked Rust
// artifact. This identifier is not a runtime cryptographic attestation.
const char *tbc_dart_reviewed_identity(void);
// Private keyless ABI. Only prepareReviewedStage/finalizeReviewedStage. No
// dynamic path, key access, HTTP, retries, parsing or transaction algorithms.
int tbc_dart_reviewed_call(const uint8_t *method, size_t method_len,
    const uint8_t *input, size_t input_len, TbcDartReviewedOutput *output);
void tbc_dart_reviewed_free(TbcDartReviewedOutput output);
#ifdef __cplusplus
}
#endif
#endif
