#ifndef TBC_SIGNER_MUSIG_H
#define TBC_SIGNER_MUSIG_H
#include <stdint.h>
#include <stddef.h>
#ifdef __cplusplus
extern "C" {
#endif
/* OPTIONAL wallet-private ABI, feature musig. No DApp access. Version 1.
 * Fixed byte sizes: keys=count*33, aggregate/digest/binding/scalar/entropy/
 * handle/partial=32, public_nonce=66, signature=64. Count 2..32.
 * Buffers must be valid, disjoint and live. Entropy must be fresh OS CSPRNG
 * data and is erased. Caller erases its scalar. Times are trusted monotonic ms;
 * expiry is exclusive, maximum TTL 300000ms. Permission/approval must be checked
 * before begin AND sign; revoke/navigation/close must cancel affected sessions.
 * No nonce serialization or restart recovery. Every sign attempt burns handle.
 * 0 success; 100 input; 101 group; 102 binding; 103 key; 104 nonce; 105 signature;
 * 106 consumed/unknown; 107 crypto; 108 expiry/clock; 109 capacity. */
uint32_t tbc_signer_musig_version(void);
/* Additive local5 public-only helper. Sorted unique compressed keys, count2..32;
 * output32 x-only. Not a proof of administrator authority. No session created.
 * local4 does not export this symbol; do not mix wrappers/artifacts. */
int32_t tbc_signer_musig_aggregate_key(const uint8_t *,size_t,uint8_t *);
uint8_t *tbc_signer_musig_buffer_new(void); /* 8192 bytes */
void tbc_signer_musig_buffer_free(uint8_t *);
int32_t tbc_signer_musig_begin(const uint8_t *,size_t,const uint8_t *,const uint8_t *,const uint8_t *,const uint8_t *,uint8_t *,uint64_t,uint64_t,uint8_t *,uint8_t *);
int32_t tbc_signer_musig_sign(const uint8_t *,const uint8_t *,const uint8_t *,const uint8_t *,const uint8_t *,size_t,uint64_t,uint8_t *);
void tbc_signer_musig_cancel(const uint8_t *);
void tbc_signer_musig_cancel_all(void);
int32_t tbc_signer_musig_combine(const uint8_t *,size_t,const uint8_t *,const uint8_t *,const uint8_t *,const uint8_t *,uint8_t *);
#ifdef __cplusplus
}
#endif
#endif
