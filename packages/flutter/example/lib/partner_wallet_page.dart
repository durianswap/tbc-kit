import 'dart:async';
import 'package:flutter/material.dart';
import 'package:tbc_kit_flutter_dart/packaged_wallet.dart';
import 'package:tbc_kit_flutter_dart/queries.dart';

/// Mount after native Vault/approval/signing registration and wallet.open.
/// The example contains no private key, automatic approval or hidden WebView.
class PartnerWalletPage extends StatefulWidget {
  const PartnerWalletPage({super.key, required this.wallet, required this.maxFeeAtomic});
  final TbcFlutterWallet wallet;
  final String maxFeeAtomic;
  @override State<PartnerWalletPage> createState() => _PartnerWalletPageState();
}
class _PartnerWalletPageState extends State<PartnerWalletPage> {
  TbcWalletActions? actions;
  TbcQueryClient? queries;
  final recipient = TextEditingController(), amount = TextEditingController();
  bool busy = false;
  String status = 'Enable native wallet access to continue';
  Future<void> run(Future<void> Function() body) async {
    if (busy) return;
    setState(() => busy = true);
    try { await body(); }
    catch (_) { if (mounted) setState(() => status = 'Not completed. Check wallet activity before retrying a send.'); }
    finally { if (mounted) setState(() => busy = false); }
  }
  Future<void> open() async {
    final local = await widget.wallet.openActions();
    try {
      await local.requestPermissions({
        for (final name in ['tbc_accounts', 'tbc_accountMetadata', 'tbc_signTransaction', 'tbc_sendTransaction'])
          name: {'chains': [local.network.chainId], if (name == 'tbc_accounts') 'maxAccounts': 1},
      });
      if (!mounted) { await local.dispose(); return; }
      actions = local;
      queries = TbcQueryClient(network: local.network);
      setState(() => status = local.account.address);
    } catch (_) { await local.dispose(); rethrow; }
  }
  Future<void> send() async {
    final local = actions!;
    final request = local.transactionRequest(
      intent: {'version': '1.0', 'type': 'tbc.transfer', 'to': recipient.text.trim(),
        'amount': parseTbcDisplayAmount(amount.text.trim(), tbcAtomicDecimals)},
      constraints: {'maxFee': widget.maxFeeAtomic},
    );
    final result = await local.sendTransaction(request);
    if (mounted) setState(() => status = result is Map ? 'Submitted: ${result['txid'] ?? result['txids'] ?? 'see wallet activity'}' : 'Submitted');
  }
  Future<void> balance() async {
    final result = await queries!.balanceByAddress(actions!.account.address);
    if (mounted) setState(() => status = 'Balance (atomic): ${result['balance']}');
  }
  @override Widget build(BuildContext context) => Scaffold(
    appBar: AppBar(title: const Text('TBC wallet')),
    body: Padding(padding: const EdgeInsets.all(16), child: ListView(children: [
      Text(status),
      if (actions == null) ElevatedButton(onPressed: busy ? null : () => run(open), child: const Text('Enable native wallet access')),
      if (actions != null) ...[
        TextField(controller: recipient, decoration: const InputDecoration(labelText: 'Recipient address')),
        TextField(controller: amount, keyboardType: const TextInputType.numberWithOptions(decimal: true), decoration: const InputDecoration(labelText: 'TBC amount')),
        Text('Maximum fee: ${formatTbcAtomicAmount(widget.maxFeeAtomic, tbcAtomicDecimals)} TBC'),
        ElevatedButton(onPressed: busy ? null : () => run(send), child: const Text('Review transfer')),
        TextButton(onPressed: busy ? null : () => run(balance), child: const Text('Refresh balance')),
      ],
      if (busy) const LinearProgressIndicator(),
    ])),
  );
  @override void dispose() {
    queries?.close(); unawaited(actions?.dispose());
    recipient.dispose(); amount.dispose(); super.dispose();
  }
}
