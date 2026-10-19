part of 'wallet_host.dart';

/// Sanitized public failure. Never contains native exceptions, keys or raw
/// signing witnesses. A failed send is not permission to retry a broadcast.
final class TbcWalletException implements Exception {
  const TbcWalletException(this.code, this.message);
  final int code;
  final String message;
  @override
  String toString() => 'TbcWalletException($code, $message)';
}

/// Native wallet-page calls using the same Standard executor as DApps.
/// Request maps and result maps are the Standard DTOs, not Legacy DTOs.
/// All amounts are decimal integer strings in the asset's smallest unit.
final class TbcWalletActions {
  TbcWalletActions._(
    this._wallet,
    this._session,
    this._control,
    this._delivery,
  );
  final TbcFlutterWallet _wallet;
  final TbcProviderSession _session;
  final TbcNativeDocumentControl _control;
  final _LocalDelivery _delivery;
  int _sequence = 0;
  bool _closed = false;

  TbcNetworkConfiguration get network => _control.network;
  TbcAccount get account {
    _control.requireCurrent();
    return _control.selectedAccount;
  }

  Future<void> _frame(String type, [Map<String, Object?> fields = const {}]) {
    final n = _delivery.navigation;
    return _session.accept(
      canonical({
        'channel': TbcNativeWalletProtocol.standard.wireChannel,
        'type': type,
        'sessionId': n.sessionId,
        'navigationId': n.navigationId,
        'messageId': 'local-${++_sequence}',
        ...fields,
      }),
      TbcWebViewMessageSource(
        webViewInstanceId: n.webViewInstanceId,
        sessionId: n.sessionId,
        navigationId: n.navigationId,
        origin: n.origin,
        topOrigin: n.origin,
        isMainFrame: true,
      ),
    );
  }

  /// No arbitrary native commands or permission bypass. Method support and
  /// params are checked by the existing Provider and native custody path.
  Future<Object?> request(String method, [Object? params]) async {
    if (_closed) throw const TbcWalletException(4900, 'Wallet session closed');
    _control.requireCurrent();
    final id = 'call-${++_sequence}';
    try {
      await _frame('request', {
        'request': {
          'jsonrpc': '2.0',
          'id': id,
          'method': method,
          if (params != null) 'params': params,
        },
      });
      final frame = _delivery.responses.remove(id);
      if (frame == null || _closed || !_session.wire.isActive) {
        throw const TbcWalletException(4900, 'Wallet session closed');
      }
      _control.requireCurrent();
      await _frame('ack', {'deliveryId': frame['deliveryId']});
      if (_closed || !_session.wire.isActive) {
        throw const TbcWalletException(4900, 'Wallet session closed');
      }
      final response = frame['response'] as Map;
      if (response['error'] is Map) {
        final error = response['error'] as Map;
        throw TbcWalletException(
          error['code'] as int,
          error['message'] as String,
        );
      }
      return frozen(response['result']);
    } finally {
      _delivery.responses.remove(id);
    }
  }

  /// Explicit initial permission approval, separate from each transaction's
  /// one approval. Grants belong only to this wallet's native-page principal.
  Future<Object?> requestPermissions(Map<String, Object?> permissions) =>
      request('wallet_requestPermissions', [permissions]);
  Future<Object?> getCapabilities() => request('tbc_getCapabilities');
  Future<Object?> getAccounts() => request('tbc_accounts');
  Future<Object?> disconnect() => request('tbc_disconnect');
  Future<Object?> signMessage(Map<String, Object?> message) =>
      request('tbc_signMessage', message);
  Future<Object?> signTypedData(Map<String, Object?> data) =>
      request('tbc_signTypedData', data);
  Future<Object?> signTransaction(Map<String, Object?> transaction) =>
      request('tbc_signTransaction', transaction);
  Future<Object?> sendTransaction(Map<String, Object?> transaction) =>
      request('tbc_sendTransaction', transaction);
  Future<Object?> signPreparedTransaction(Map<String, Object?> transaction) =>
      request('tbc_signPreparedTransaction', transaction);
  Future<Object?> sendPreparedTransaction(Map<String, Object?> transaction) =>
      request('tbc_sendPreparedTransaction', transaction);
  Future<Object?> signWorkflow(Map<String, Object?> workflow) =>
      request('tbc_signWorkflow', workflow);
  Future<Object?> sendWorkflow(Map<String, Object?> workflow) =>
      request('tbc_sendWorkflow', workflow);
  Future<Object?> signPreparedWorkflow(Map<String, Object?> workflow) =>
      request('tbc_signPreparedWorkflow', workflow);
  Future<Object?> sendPreparedWorkflow(Map<String, Object?> workflow) =>
      request('tbc_sendPreparedWorkflow', workflow);

  /// Build the common request envelope only. Kit's existing Engine still
  /// selects inputs, builds, validates and finalizes every supported intent.
  Map<String, Object?> transactionRequest({
    required Map<String, Object?> intent,
    required Map<String, Object?> constraints,
  }) => Map.unmodifiable({
    'version': '1.0',
    'chainId': network.chainId,
    'from': account.address,
    'intent': frozen(intent),
    'constraints': frozen(constraints),
  });

  /// Cancels pending work and fences native permits; never retries a send.
  Future<void> dispose() async {
    if (_closed) return;
    _closed = true;
    try {
      await _session.close();
    } finally {
      _delivery.responses.clear();
      if (identical(_wallet._actions, this)) _wallet._actions = null;
    }
  }
}

// In-memory transport, not a hidden WebView. Reuse the proven request/cancel/
// result lifecycle and native attestation without another executor or HTTP read.
final class _LocalDelivery implements TbcDocumentDelivery {
  _LocalDelivery(this.channel, this.ownerId, this.navigation);
  final MethodChannel channel;
  final String ownerId;
  final TbcWebViewNavigation navigation;
  final responses = <String, Map<String, dynamic>>{};
  bool _closed = false;
  Map<String, Object?> get _scope => {
    'ownerId': ownerId,
    'scope': navigation.toWire(),
  };
  @override
  Future<bool> deliver(String text, TbcWebViewNavigation expected) async {
    if (_closed || !navigation.matches(expected.toWire())) return false;
    final result = await channel.invokeMapMethod<String, dynamic>(
      'local.deliver',
      {..._scope, 'text': text},
    );
    if (_closed || result?['ok'] != true || result?['value'] != true)
      return false;
    final frame = jsonDecode(text) as Map<String, dynamic>;
    if (frame['type'] == 'delivery') {
      responses[frame['response']['id'] as String] = frame;
    }
    return true;
  }

  @override
  Future<bool> describe(
    Map<String, Object?> value,
    TbcWebViewNavigation expected,
  ) async => !_closed && navigation.matches(expected.toWire());
  @override
  Future<void> close(TbcWebViewNavigation expected) async {
    if (_closed) return;
    _closed = true;
    responses.clear();
    await channel.invokeMethod<Object?>('local.close', _scope);
  }
}
