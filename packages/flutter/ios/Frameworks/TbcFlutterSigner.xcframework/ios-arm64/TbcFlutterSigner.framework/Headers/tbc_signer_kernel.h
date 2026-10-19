#ifndef TBC_SIGNER_KERNEL_H
#define TBC_SIGNER_KERNEL_H
#include <stddef.h>
#include <stdint.h>
#ifdef __cplusplus
extern "C" {
#endif
uint32_t tbc_signer_kernel_version(void);
/* Wallet-only. All buffers must be valid and disjoint. Encoding/output size:
   64/64 = compact ECDSA, 65/65 = recoverable ECDSA, 164/64 = BIP340 Schnorr.
   Schnorr uses deterministic zero-auxiliary nonce generation; no sighash suffix.
   Digest and scalar: exactly 32 bytes. No prehash. Status: 0 success, 1 input,
   2 invalid scalar, 3 encoding. Caller remains responsible for its key buffers. */
int32_t tbc_signer_sign_digest(const uint8_t *, size_t, const uint8_t *, size_t,
                             uint32_t, uint8_t *, size_t);
uint8_t *tbc_signer_buffer_new(void);
void tbc_signer_buffer_free(uint8_t *);
/* Isolated BIE1 self-crypto. Returns output length or a negative error. */
int32_t tbc_signer_bie1(const uint8_t *, size_t, const uint8_t *, size_t,
                      uint32_t, uint8_t *, size_t);
#ifdef __cplusplus
}
#endif
#endif
