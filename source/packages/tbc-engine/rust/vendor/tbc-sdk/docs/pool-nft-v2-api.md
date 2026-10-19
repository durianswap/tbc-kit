# PoolNFT v2 API

`PoolNftV2` implements PoolNFT **v2 only** and is synchronized with
`tbc-contract@1.6.6`. PoolNFT v1 is unsupported. New creation supports released
plans 1-6 and FT v4/StableCoin v4 authority while existing supported Pool and
FT generations retain their original spend ABI.
All builders are offline and take explicit, validated ancestry contexts. Pool
creation additionally requires released FT authority: the FT metadata and its
exact mint transaction. The online helpers only query and construct those same
contexts; they never contain another transaction-building implementation. This
makes a zero-confirmation child use the offline context directly, while a
confirmed/indexed UTXO can use the resolver.

For locked pools, initialization and later liquidity increases detect the lock
directly from the spent Pool Code, decode its LP-cost address and amount,
deduct the cost from the requested TBC reserve increase, and place the payment
at output 6. Callers do not select the old or new NFT/Pool ABI manually.

```rust
use tbc_sdk::{
    Ft, FtInfo, PoolFtAuthority, PoolNftV2, PrivateKey, Result, Transaction, Utxo,
};

// `ft_mint` is the exact `MintFtTx::mint` transaction returned when `ft` was
// minted (or the same raw transaction fetched by its id). `funding` is a real
// creator-controlled P2PKH UTXO used only to fund Pool creation.
fn build_pool_creation(
    ft: &Ft,
    ft_mint: &Transaction,
    creator: &PrivateKey,
    funding: Utxo,
) -> Result<Vec<Transaction>> {
    let authority = PoolFtAuthority {
        info: FtInfo {
            contract_txid: Some(ft_mint.txid().to_string()),
            code_script: ft.code_script.clone(),
            tape_script: ft.tape_script.clone(),
            total_supply_raw: ft.total_supply_raw,
            decimal: ft.decimal,
            name: ft.name.clone(),
            symbol: ft.symbol.clone(),
        },
        contract_tx: ft_mint.clone(),
    };
    let pool = PoolNftV2::for_create(ft_mint.txid(), authority)?;
    pool.create_pool(creator, funding, "my-service", 35, 1, false)
}
```

`for_create` validates the authority immediately, including the contract id,
released Code/Tape output positions, scripts, satoshi values, FT family, and
metadata. Invalid or unbound authority is rejected before a Pool handle exists.
Use `for_state(ft_contract_id)` only for released arithmetic and tape helpers;
it deliberately carries no creation authority and cannot call either creation
builder successfully. Existing applications may temporarily use the deprecated
`for_create_with_ft_authority` alias, which delegates to `for_create`.

For an indexed Pool, `resolve_pool_spend_context` fetches the current Pool
output, its parent and grandparent, and the FT authority. Use
`resolve_operation_context` after choosing FT/FTLP UTXOs to obtain the exact
`PoolOperationContext` accepted by `init_pool`, `increase_lp`, `consume_lp`,
the swaps, and pool-held FT merge. The public indexer does not expose a
canonical sufficient-FT selection endpoint, so FT input selection remains
explicit. `resolve_ftlp_spends` resolves every owner FTLP UTXO for the
standalone unlock/merge/burn builders and binds the supplied fee input's
parent transaction.

For indexed parents, the thin `*_online` methods resolve a context and call
the corresponding offline builder: `init_pool_online`, `increase_lp_online`,
`consume_lp_online`, `swap_to_token_online`, `swap_to_tbc_online`,
`unlock_ftlp_online`, `merge_ftlp_online`, `burn_ftlp_online`, and
`merge_ft_in_pool_online`. They accept selected FT/FTLP UTXOs where the
indexer cannot safely infer selection. There is deliberately no
`swap_to_tbc_local_online`: it is for caller-supplied zero-confirmation
ancestry and must use `swap_to_tbc_local`.

`fetch_ftlp_utxos` and `fetch_ftlp_balance` derive the owner code from the
live Pool and validated FT authority. `fetch_ftlp_lock_times` is valid only for
a lock-time-enabled Pool and returns one `FtlpLockTimeEntry` per FTLP UTXO.

## Released method mapping

| JavaScript 1.6.6 | Go | Rust v2 equivalent |
| --- | --- | --- |
| `initCreate` | `InitCreate` | `PoolNftV2::for_create(ft_contract_id, PoolFtAuthority)`; use `for_state` only for non-creation arithmetic/tape state |
| `initfromContractId` | `InitFromContractID` | `PoolNftV2::from_contract_id` |
| `updatePoolNFT` | `UpdatePoolNFT` | `PoolNftV2::update_pool_state` |
| `getPoolNftTape` | `GetPoolNftTape` | `PoolNftV2::pool_tape` |
| `getPoolNftUnlockOffLine` | `GetPoolNftUnlockOffLine` | `PoolNftV2::pool_unlock_offline` |
| `createPoolNFT` | `CreatePoolNFT` | `PoolNftV2::create_pool` |
| `createPoolNftWithLock` | `CreatePoolNFTWithLock` | `PoolNftV2::create_pool_with_lock` |
| `initPoolNFT` | `InitPoolNFT` | `PoolNftV2::init_pool` / `init_pool_online` |
| `increaseLP` | `IncreaseLP` | `PoolNftV2::increase_lp` / `increase_lp_online` |
| `consumeLP` | `ConsumeLP` | `PoolNftV2::consume_lp` / `consume_lp_online` |
| `swaptoToken_baseTBC` | `SwapToToken` | `PoolNftV2::swap_to_token` / `swap_to_token_online` |
| `swaptoTBC_baseToken` | `SwapToTBC` | `PoolNftV2::swap_to_tbc` / `swap_to_tbc_online` |
| `swaptoTBC_baseToken_local` | `SwapToTBCLocal` | `PoolNftV2::swap_to_tbc_local` |
| `unlockFTLP` | `UnlockFTLP` | `PoolNftV2::unlock_ftlp` / `unlock_ftlp_online` |
| `mergeFTLP` | `MergeFTLP` | `PoolNftV2::merge_ftlp` / `merge_ftlp_online` |
| `burnFTLP` | `BurnFTLP` | `PoolNftV2::burn_ftlp` / `burn_ftlp_online` |
| `mergeFTinPool` | `MergeFTinPool` | `PoolNftV2::merge_ft_in_pool` / `merge_ft_in_pool_online` |
| `fetchPoolNftInfo` | — | `ApiClient::fetch_pool_nft_info` / `from_contract_id` |
| `fetchPoolNftUTXO` | — | `ApiClient::fetch_pool_nft_utxo` / `resolve_pool_spend_context` |
| `fetchFtlpUTXOList` | `FetchFtLpUTXOList` | `PoolNftV2::fetch_ftlp_utxos` |
| `fetchFtlpBalance` | `FetchFtlpBalance` | `PoolNftV2::fetch_ftlp_balance` |
| `fetchFtlpLockTime` | `FetchFtlpLockTime` | `PoolNftV2::fetch_ftlp_lock_times` |
| `fetchFtlpUTXO` | `fetchFtlpUTXO` | `ApiClient::fetch_ftlp_utxo_for_amount` after deriving/querying the FTLP code; no hidden selection wrapper |
| `getPoolNftUnlock` | `getPoolNftUnlock` | `pool_unlock_offline`; callers resolve context first |
| `getPoolNftCode` / `getPoolNftCodeWithLock` | private equivalents | `pool_code` / `locked_pool_code` |
| `getFtlpCode` / `getFtlpCodeWithLockTime` | private equivalents | `ftlp_code` / `ftlp_lock_time_code` |
| `updatePoolNftTape` / `fetchPoolNftTape` | `updatePoolNftTape` | `resolve_pool_spend_context` plus `pool_tape` |
| `getPoolNftExtraInfo` | — | `PoolNftV2::state`: `amounts`, partial hashes, FT-A contract id, service fee rate, LP plan, and lock flags |
| `getLpIncome` | — | unsupported: deprecated display calculation; use explicit integer state and application accounting |
| `initPoolNFTWithLockTime`, `increaseLpWithLockTime`, `consumeLpWithLockTime` | — | Generic `init_pool`, `increase_lp`, and `consume_lp`; lock-time behavior is selected by `PoolState::ftlp_lock_time_enabled` and the existing explicit context parameters |

The `ApiClient` equivalents remain available for applications which already
hold a concrete FTLP code: `fetch_ftlp_utxos`, `fetch_ftlp_balance`, and
`fetch_ftlp_utxo_for_amount`.
