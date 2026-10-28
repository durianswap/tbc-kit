#pragma once
#include <jsi/jsi.h>
#include <algorithm>
#include <cstring>

// Optional private-VM byte codec. No keys, hashes, permissions, or cached data.
// Non-ASCII returns undefined so the existing Unicode codec remains authoritative.
inline void installTbcAsciiEncoder(facebook::jsi::Runtime& rt) {
  namespace jsi = facebook::jsi;
  rt.global().setProperty(rt, "__tbcNativeEncodeAscii", jsi::Function::createFromHostFunction(rt,
    jsi::PropNameID::forAscii(rt, "__tbcNativeEncodeAscii"), 1,
    [](jsi::Runtime& r, const jsi::Value&, const jsi::Value* args, size_t count) -> jsi::Value {
      if (count != 1 || !args[0].isString()) throw jsi::JSError(r, "INVALID_ASCII_INPUT");
      const auto text = args[0].getString(r).utf8(r);
      if (std::any_of(text.begin(), text.end(), [](unsigned char c) { return c >= 128; }))
        return jsi::Value::undefined();
      auto result = r.global().getPropertyAsFunction(r, "Uint8Array")
        .callAsConstructor(r, static_cast<double>(text.size())).getObject(r);
      auto buffer = result.getPropertyAsObject(r, "buffer").getArrayBuffer(r);
      if (buffer.size(r) != text.size()) throw jsi::JSError(r, "INVALID_ASCII_BUFFER");
      if (!text.empty()) std::memcpy(buffer.data(r), text.data(), text.size());
      return result;
    }));
}
