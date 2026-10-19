/// Flutter package entry. Native registration still requires wallet-owned
/// account, approval and Vault adapters; no account or grant is created here.
library;

import 'package:flutter/services.dart';
import 'src/internal/signing_worker.dart';

export 'flutter_wallet.dart';

/// Loads build-pinned package identity, not an arbitrary page-supplied path.
/// The existing worker hashes the file before loading, off the UI isolate.
Future<TbcPinnedComputeLibrary> tbcPackagedComputeLibrary() async {
  const channel = MethodChannel('io.tbc.kit.dart/package');
  final value = await channel.invokeMapMethod<String, dynamic>('computeArtifact');
  if (value == null ||
      value.length != 2 ||
      value['path'] is! String ||
      value['sha256'] is! String) {
    throw StateError('TBC native package not registered');
  }
  return TbcPinnedComputeLibrary(path: value['path'], sha256: value['sha256']);
}
