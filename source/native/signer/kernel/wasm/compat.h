/* secp256k1-sys 0.11's freestanding WASM string.h omits this C declaration.
 * Implementation is supplied by the Rust WASM compiler builtins, not a crypto fork.
 */
#include <stddef.h>
void *memmove(void *destination, const void *source, size_t count);
