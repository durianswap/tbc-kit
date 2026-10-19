# Assets and unified business methods

The public [business namespaces](../../SUPPORT.md#business-methods) map to
shared transaction preparation and signing paths. New assets use current
contracts. Existing assets are recognized from their script and bound material,
not from an unverified version label supplied by the DApp.

## Contract routing

| Contract | Unified holder operations |
| --- | --- |
| TBC20 and supported historical FT | Transfer, merge |
| New and supported historical stablecoin | Transfer, merge |
| TBC721 and supported historical NFT | Transfer |
| New AMM / LP | Swap, add/remove liquidity; LP transfer, lock, unlock, merge |
| Historical Pool2 / LP | Swap, add/remove liquidity, Pool token merge; LP merge/burn |

The underlying template determines valid parameters and roles. For example,
historical Pool liquidity additions retain their TBC budget semantics, while
current-only limits and independent controller roles cannot be silently
discarded to execute a historical transaction.

## Creation and administration

New creation uses the corresponding current contract. Stablecoin administrator
operations require the administrator's actual account and authorization;
being the fee payer does not grant administrator authority.

Creation, holder operations and Prepared execution use the existing generic
Provider methods. There is no separate Provider method for every asset.

## Approval and data reuse

After planning, `preview.contractExecution` binds the business type,
implementation and generation into the plan hash. The approval presenter uses
this authenticated material. Early review leaves unverified values unknown.

Material loaders reuse required origin bytes and the selected network's
request context. Contract recognition is local computation, not an additional
version-discovery API call.

Use the [usage guide](../usage.md) for call examples and the installed types
for operation-specific parameters.
