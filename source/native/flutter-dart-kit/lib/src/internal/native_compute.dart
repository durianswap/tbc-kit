// P0 only: keyless computation, NOT a wallet runtime or a DApp entry point.
// The caller must supply a verified/pinned library, never a page-controlled path.
import 'dart:convert';
import 'dart:ffi';
import 'package:ffi/ffi.dart';

final class _RustBuffer extends Struct {
  external Pointer<Uint8> ptr;
  @UintPtr()
  external int len;
  @UintPtr()
  external int cap;
}

typedef _CallNative =
    _RustBuffer Function(Pointer<Uint8>, UintPtr, Pointer<Uint8>, UintPtr);
typedef _CallDart =
    _RustBuffer Function(Pointer<Uint8>, int, Pointer<Uint8>, int);
typedef _FreeNative = Void Function(_RustBuffer);
typedef _FreeDart = void Function(_RustBuffer);

final class ComputeProbe {
  ComputeProbe(DynamicLibrary library)
    : _engine = library.lookupFunction<_CallNative, _CallDart>(
        'tbc_engine_call',
      ),
      _keyless = library.lookupFunction<_CallNative, _CallDart>(
        'tbc_keyless_call',
      ),
      _engineFree = library.lookupFunction<_FreeNative, _FreeDart>(
        'tbc_engine_free',
      ),
      _keylessFree = library.lookupFunction<_FreeNative, _FreeDart>(
        'tbc_keyless_free',
      );

  final _CallDart _engine, _keyless;
  final _FreeDart _engineFree, _keylessFree;

  // Synchronous probe, no retry/cache/signing. Future wallet integration must
  // run expensive contract work off the UI isolate and preserve cancellation.
  String call(String kind, String method, String input) {
    if (kind != 'engine' && kind != 'keyless') {
      throw ArgumentError('Unknown computation lane');
    }
    final methodBytes = utf8.encode(method), inputBytes = utf8.encode(input);
    if (methodBytes.isEmpty ||
        methodBytes.length > 128 ||
        inputBytes.length > 16 * 1024 * 1024) {
      throw ArgumentError('Probe input exceeds ABI bound');
    }
    final m = calloc<Uint8>(methodBytes.length);
    final i = calloc<Uint8>(inputBytes.isEmpty ? 1 : inputBytes.length);
    try {
      m.asTypedList(methodBytes.length).setAll(0, methodBytes);
      i.asTypedList(inputBytes.length).setAll(0, inputBytes);
      final result = (kind == 'engine' ? _engine : _keyless)(
        m,
        methodBytes.length,
        i,
        inputBytes.length,
      );
      try {
        if (result.len > result.cap ||
            result.len > 32 * 1024 * 1024 ||
            (result.len != 0 && result.ptr == nullptr)) {
          throw StateError('Invalid Rust buffer');
        }
        return result.len == 0
            ? ''
            : utf8.decode(result.ptr.asTypedList(result.len));
      } finally {
        (kind == 'engine' ? _engineFree : _keylessFree)(result);
      }
    } finally {
      calloc.free(i);
      calloc.free(m);
    }
  }
}
