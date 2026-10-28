#include "tbc_engine.h"

#include <stdio.h>
#include <stdlib.h>
#include <string.h>

int main(int argc, char **argv) {
  if (argc != 3) {
    fputs("usage: native-artifact-runner METHOD JSON\n", stderr);
    return 64;
  }
  /* Large public test vectors must not depend on the OS argv byte limit. */
  char *owned_input = NULL;
  const char *input = argv[2];
  size_t length = strlen(input);
  if (strcmp(input, "-") == 0) {
    size_t capacity = 65536;
    owned_input = malloc(capacity);
    if (!owned_input) return 71;
    length = 0;
    for (;;) {
      if (length == capacity) {
        if (capacity >= 64 * 1024 * 1024) { free(owned_input); return 65; }
        capacity *= 2;
        char *next = realloc(owned_input, capacity);
        if (!next) { free(owned_input); return 71; }
        owned_input = next;
      }
      size_t count = fread(owned_input + length, 1, capacity - length, stdin);
      length += count;
      if (count == 0) {
        if (ferror(stdin)) { free(owned_input); return 74; }
        break;
      }
    }
    input = owned_input;
  }
  TbcEngineBuffer result = tbc_engine_call(
      (const uint8_t *)argv[1], strlen(argv[1]),
      (const uint8_t *)input, length);
  free(owned_input);
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
