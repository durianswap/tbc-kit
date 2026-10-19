#include "tbc_engine.h"

#include <stdio.h>
#include <string.h>

int main(int argc, char **argv) {
  if (argc != 3) {
    fputs("usage: native-artifact-runner METHOD JSON\n", stderr);
    return 64;
  }
  TbcEngineBuffer result = tbc_engine_call(
      (const uint8_t *)argv[1], strlen(argv[1]),
      (const uint8_t *)argv[2], strlen(argv[2]));
  if (result.ptr == NULL && result.len != 0) {
    fputs("native adapter returned an invalid buffer\n", stderr);
    return 70;
  }
  if (result.len != 0 && fwrite(result.ptr, 1, result.len, stdout) != result.len) {
    tbc_engine_free(result);
    return 74;
  }
  tbc_engine_free(result);
  return 0;
}
