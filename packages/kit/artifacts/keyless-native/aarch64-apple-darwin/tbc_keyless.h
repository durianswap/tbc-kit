#ifndef TBC_KEYLESS_H
#define TBC_KEYLESS_H

#include <stddef.h>
#include <stdint.h>

#ifdef __cplusplus
extern "C" {
#endif

typedef struct TbcKeylessBuffer {
  uint8_t *ptr;
  size_t len;
  size_t cap;
} TbcKeylessBuffer;

TbcKeylessBuffer tbc_keyless_call(
    const uint8_t *operation_ptr,
    size_t operation_len,
    const uint8_t *input_ptr,
    size_t input_len);

void tbc_keyless_free(TbcKeylessBuffer buffer);

#ifdef __cplusplus
}
#endif

#endif
