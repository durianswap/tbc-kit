#include "tbc_signer_kernel.h"

#include <stdint.h>
#include <stdio.h>
#include <string.h>

/* Public-fixture smoke probe for paired iOS Simulator and Android libraries. */
int main(void) {
  const uint8_t message[] = "public BIE1 simulator fixture";
  uint8_t scalar[32] = {0};
  uint8_t wrong_scalar[32] = {0};
  uint8_t encrypted[128] = {0};
  uint8_t decrypted[128] = {0};
  scalar[31] = 1;
  wrong_scalar[31] = 2;

  const int32_t encrypted_len = tbc_signer_bie1(
      message, sizeof(message) - 1, scalar, sizeof(scalar), 0, encrypted,
      sizeof(encrypted));
  if (encrypted_len <= 0 || encrypted_len > (int32_t)sizeof(encrypted)) {
    fputs("BIE1_ENCRYPT_FAIL\n", stderr);
    return 1;
  }
  const int32_t decrypted_len = tbc_signer_bie1(
      encrypted, (size_t)encrypted_len, scalar, sizeof(scalar), 1, decrypted,
      sizeof(decrypted));
  if (decrypted_len != (int32_t)(sizeof(message) - 1) ||
      memcmp(decrypted, message, sizeof(message) - 1) != 0) {
    fputs("BIE1_ROUNDTRIP_FAIL\n", stderr);
    return 2;
  }
  if (tbc_signer_bie1(encrypted, (size_t)encrypted_len, wrong_scalar,
                      sizeof(wrong_scalar), 1, decrypted,
                      sizeof(decrypted)) >= 0) {
    fputs("BIE1_WRONG_KEY_ACCEPTED\n", stderr);
    return 3;
  }
  encrypted[37] ^= 1;
  if (tbc_signer_bie1(encrypted, (size_t)encrypted_len, scalar, sizeof(scalar),
                      1, decrypted, sizeof(decrypted)) >= 0) {
    fputs("BIE1_TAMPER_ACCEPTED\n", stderr);
    return 4;
  }
  memset(scalar, 0, sizeof(scalar));
  memset(wrong_scalar, 0, sizeof(wrong_scalar));
  memset(encrypted, 0, sizeof(encrypted));
  memset(decrypted, 0, sizeof(decrypted));
  puts("BIE1_SIMULATOR_SMOKE_PASS");
  return 0;
}
