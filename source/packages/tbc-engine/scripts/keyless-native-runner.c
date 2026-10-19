#include "tbc_keyless.h"

#include <stdio.h>
#include <string.h>

int main(int argc, char **argv) {
  if (argc != 3) {
    fputs("usage: keyless-native-runner OPERATION JSON\n", stderr);
    return 64;
  }
  TbcKeylessBuffer result = tbc_keyless_call(
      (const uint8_t *)argv[1], strlen(argv[1]),
      (const uint8_t *)argv[2], strlen(argv[2]));
  if (result.ptr == NULL && result.len != 0) {
    fputs("native adapter returned an invalid buffer\n", stderr);
    return 70;
  }
  if (result.len != 0 && fwrite(result.ptr, 1, result.len, stdout) != result.len) {
    tbc_keyless_free(result);
    return 74;
  }
  tbc_keyless_free(result);
  return 0;
}
