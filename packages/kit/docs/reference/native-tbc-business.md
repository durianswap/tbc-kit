# Native TBC business entry

Use `wallet.tbc.transfer` to send TBC and `wallet.tbc.merge` for UTXO maintenance.

```ts
const wallet = await createTbcClient({ network: 'testnet' }).connect();
await wallet.tbc.transfer({
  to: recipient,
  amount: '1000', // atomic-unit decimal string, not display TBC
  constraints: { maxFee: '500' },
});
await wallet.tbc.merge({ constraints: { maxFee: '1000' } });
```

The connected wallet's selected chain and account are preserved. These conveniences request wallet construction and sending through `tbc_sendTransaction`; they do not build, sign, fetch chain data or broadcast inside the DApp. The wallet's existing Core/Host/Engine and approval checks still apply. This rename does not change merge input selection, fees, prefetch or recovery.

For signing without sending, use the existing `wallet.walletBuild.sign({ intent, constraints })` path. For DApp or server construction, use the existing `prepareTbcTransaction`/workflow path and independent signer or wallet proposal methods. They are separate trust boundaries, not interchangeable aliases for `tbc.transfer`.


No new Provider method or event is introduced. Internal intent types remain `tbc.transfer` and `tbc.maintenance.merge`. Runtime input cannot override these helpers' type/version. Invalid transaction content remains subject to normal shared validation; the conveniences are not an approval or a substitute for wallet validation.

The lightweight client can contain lazy JavaScript inspection adapters used by other optional utilities. Calling these TBC conveniences does not load or initialize a WASM binary. This is distinct from claiming that every root export is zero-size or contains no Engine-related JavaScript.
