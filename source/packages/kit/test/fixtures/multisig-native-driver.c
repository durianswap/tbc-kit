/* Offline ABI test driver. Input is public fixture JSON, never a private key. */
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include "tbc_keyless.h"

int main(int argc, char **argv) {
  if (argc != 2) return 2;
  const size_t limit = 16 * 1024 * 1024;
  unsigned char *input = malloc(limit + 1);
  if (!input) return 3;
  size_t length = fread(input, 1, limit + 1, stdin);
  if (length > limit || ferror(stdin)) { free(input); return 4; }
  TbcKeylessBuffer result = tbc_keyless_call(
      (const uint8_t *)argv[1], strlen(argv[1]), input, length);
  free(input);
  size_t written = fwrite(result.ptr, 1, result.len, stdout);
  int ok = written == result.len && !ferror(stdout);
  tbc_keyless_free(result);
  return ok ? 0 : 5;
}
