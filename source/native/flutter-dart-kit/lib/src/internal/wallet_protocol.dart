/// Native registration identity, never inferred from a page parameter or grant.
/// Standard keeps its existing private-channel envelope for current consumers.
enum TbcNativeWalletProtocol {
  standard('tws/1.0'),
  legacy('legacy-window-turing/v1');

  const TbcNativeWalletProtocol(this.namespace);
  final String namespace;
  // Private shared RPC framing. The historical window.Turing surface is a
  // page-side DTO adapter, not a second trusted result/execution protocol.
  String get wireChannel => switch (this) {
    standard => 'tws-webview/1',
    legacy => 'legacy-window-turing-shared/1',
  };
}
