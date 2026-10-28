/// Flutter package entry. Native registration still requires wallet-owned
/// account, approval and Vault adapters; no account or grant is created here.
library;

import 'package:flutter/services.dart';
import 'dart:convert';
import 'dart:ffi';
import 'dart:io';
import 'dart:isolate';
import 'package:crypto/crypto.dart';
import 'src/internal/signing_worker.dart';
import 'src/internal/native_compute.dart';
import 'src/internal/protocol_codec.dart';
import 'src/configuration.dart';
import 'src/nft_query.dart';

export 'flutter_wallet.dart';
export 'src/nft_query.dart' show Tbc721Reader;

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

/// Read-only NFT mint-slot queries using the packaged, pinned keyless parser.
/// No wallet account, permission, signing, funding or broadcast is requested.
/// Immutable collection layouts are reused; mutable slot state stays fresh.
/// Parsing runs off the UI isolate and uses the existing Rust implementation.
Future<Tbc721Reader> openTbcPackagedNftReader({
  required TbcNetworkConfiguration network,
}) async {
  final pinned = await tbcPackagedComputeLibrary();
  final path = pinned.path, expected = pinned.sha256;
  await Isolate.run(() async {
    final digest = await sha256.bind(File(path).openRead()).first;
    need(digest.toString() == expected, 'COMPUTE_INTEGRITY');
    ComputeProbe(DynamicLibrary.open(path));
  });
  return Tbc721Reader(network: network, inspectCollection: (id, raw) =>
    Isolate.run(() => copied(jsonDecode(
      ComputeProbe(DynamicLibrary.open(path)).call('keyless',
        'inspectTokenMaterial', canonical({'phase': 'inspectCollection',
          'contractId': id, 'rawTransaction': raw})),
    ))));
}
