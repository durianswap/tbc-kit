#ifndef TBC_ENGINE_H
#define TBC_ENGINE_H

#include <stddef.h>
#include <stdint.h>

#ifdef __cplusplus
extern "C" {
#endif

typedef struct TbcEngineBuffer {
  uint8_t *ptr;
  size_t len;
  size_t cap;
} TbcEngineBuffer;

TbcEngineBuffer tbc_engine_call(
    const uint8_t *method_ptr,
    size_t method_len,
    const uint8_t *input_ptr,
    size_t input_len);

TbcEngineBuffer tbc_wallet_private_call(
    const uint8_t *method_ptr,
    size_t method_len,
    const uint8_t *input_ptr,
    size_t input_len,
    const uint8_t *scalar_ptr,
    size_t scalar_len);

void tbc_engine_free(TbcEngineBuffer buffer);

#ifdef __cplusplus
}
#endif

#endif
