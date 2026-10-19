import 'dart:async';
import 'dart:collection';
import 'dart:io';
import 'package:flutter/material.dart';
import 'package:flutter_inappwebview/flutter_inappwebview.dart';
import 'package:tbc_kit_flutter_dart/packaged_wallet.dart';

/// Call after matching native custody registration. Account/key data never
/// travels through the page. Use the same network and profile on both sides.
Future<TbcFlutterWallet> openPartnerWallet({
  required String productId,
  required String displayName,
  required String profile,
}) async => TbcFlutterWallet.open(
  configuration: TbcWalletConfiguration(
    productId: productId,
    name: displayName,
    profile: profile,
    network: TbcNetworkConfiguration.official(TbcNetwork.testnet),
  ),
  compute: await tbcPackagedComputeLibrary(),
);

/// One verified native view per tab. The wallet retains and disposes its shared
/// TbcFlutterWallet at engine teardown, not at every tab navigation.
class PartnerBrowser extends StatefulWidget {
  const PartnerBrowser({super.key, required this.wallet, required this.url});
  final TbcFlutterWallet wallet;
  final Uri url;
  @override
  State<PartnerBrowser> createState() => _PartnerBrowserState();
}

class _PartnerBrowserState extends State<PartnerBrowser> {
  TbcFlutterWalletView? view;
  String? error;
  @override
  void initState() {
    super.initState();
    unawaited(open());
  }

  Future<void> open() async {
    try {
      if (widget.url.scheme != 'https') throw StateError('HTTPS required');
      final created = await widget.wallet.createWebView();
      if (!mounted) { await created.dispose(); return; }
      setState(() => view = created);
    } catch (_) {
      if (mounted) setState(() => error = 'Wallet browser unavailable');
    }
  }

  Future<void> attach(InAppWebViewController controller) async {
    try {
      // Widget attachment only; no transaction polling, fetching or retry.
      for (var i = 0; i < 60 && mounted; i++) {
        if (await view!.attach(platformViewId: Platform.isAndroid ? controller.getViewId() as int : null)) {
          if (mounted) await controller.loadUrl(urlRequest: URLRequest(url: WebUri(widget.url.toString())));
          return;
        }
        await Future<void>.delayed(const Duration(milliseconds: 50));
      }
      throw StateError('Native view attachment unavailable');
    } catch (_) {
      if (mounted) setState(() => error = 'Wallet browser attachment failed');
    }
  }

  @override
  Widget build(BuildContext context) {
    final current = view;
    if (error != null) return Center(child: Text(error!));
    if (current == null) return const Center(child: CircularProgressIndicator());
    return InAppWebView(
      initialUrlRequest: URLRequest(url: WebUri('about:blank')),
      initialUserScripts: UnmodifiableListView([
        UserScript(source: current.markerSource, injectionTime: UserScriptInjectionTime.AT_DOCUMENT_START, forMainFrameOnly: true),
        if (current.fallbackPageSource != null)
          UserScript(source: current.fallbackPageSource!, injectionTime: UserScriptInjectionTime.AT_DOCUMENT_START, forMainFrameOnly: true),
      ]),
      onWebViewCreated: (controller) => unawaited(attach(controller)),
    );
  }
  @override
  void dispose() { unawaited(view?.dispose()); super.dispose(); }
}
