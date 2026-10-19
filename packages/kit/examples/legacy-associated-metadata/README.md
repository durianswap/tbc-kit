# Legacy associated transaction and metadata defaults

`createStandardLegacyDefaults` in `wallet.mjs` demonstrates the current
controller wiring. Construct one immutable `TbcNetworkContext`; supply the
wallet's trusted fetch driver and Standard Host dispatch callbacks. Do not
build a separate native executor or associated-signing journal for this route.

The returned metadata resolver is shared by FT transfer and Pool intent
mapping. Identical in-flight reads are single-flighted; completed values use a
short, bounded cache scoped to the network source. Pool resolution performs the
existing `pool -> FT identity -> FT metadata` sequence and reuses FT metadata
already loaded by the transfer path.

Standalone raw and associated signing map to `tbc_signReviewedTransaction`;
multi-step requests map to the Standard workflow. The Host independently
validates the material, permission and approval binding, then delegates to its
Signer. Mapping a legacy request is not authorization. No direct native signing
fallback is installed here.

Wire the returned values into the Legacy native controller:

```js
const shared = createStandardLegacyDefaults({
  network,
  fetch: platformFetch,
  standard: {
    context: verifiedLegacyContext,
    readAccount: readTrustedAccount,
    resolveSendTransaction: mapLegacySendTransaction,
    beginApprovalPreparation: sharedApprovalPreparation,
    executeAction: dispatchStandardAction,
    executeWorkflow: dispatchStandardWorkflow,
  },
});

const controller = createTbcKitLegacyWebViewNativeController({
  navigation,
  chainId: network.chainId,
  network,
  platform,
  walletVersion,
  handlers,
  bitcoinMessages,
  genericBatch: shared.genericBatch,
  transactions: shared.transactions,
  post,
});
```

`verifiedLegacyContext` comes from native top-frame navigation/session authority,
not page JSON. Dispatch callbacks enter the same session-bound Standard Host and
return its delivery envelope; the controller's handlers acknowledge deliveries.
`mapLegacySendTransaction` is the shared Kit mapper configured by the wallet,
not a second transaction builder. Permission, review and issuance restrictions
remain enforced by the Standard path.

The old `createSharedLegacyDefaults` and `completeAssociatedFromWalletSigner`
exports are retained as historical reference until final cleanup is approved.
They are not the recommended wiring and their associated service is not a
current controller option. Do not use them to bypass Standard Reviewed signing.

Do not expose the controller, Signer closure, native module or wallet
session to page code. A network switch constructs a new context, metadata
resolver, controller and source-scoped wallet runtime.
