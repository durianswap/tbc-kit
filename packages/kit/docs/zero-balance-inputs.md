# Zero-balance token outputs

Some valid TBC20 transactions, including zero-fee order matching, leave a holder Code/Tape output with a token amount of zero. Its native Code value can still be 500 atomic TBC. A zero token amount does not make that indexed output malformed or usable as an ordinary native fee input.

## Automatic selection

Kit validates index field formats and duplicate outpoints, then skips zero-balance **holder** outputs before fetching their parents or confirmations. This applies to fungible transfer/merge, token HTLC creation, token-funded orders, AMM holder inputs and LP holder selection. No extra API call or cleanup transaction is made. Selected positive inputs still pass their existing script, identity, ownership, amount, maturity and Engine validation.

Pool-owned reserve outputs are different: a zero reserve can be part of valid Pool state and is not filtered by the holder rule. Exact HTLC/order targets and cancellation/refund paths also retain their existing role-specific validation.

## Explicit inputs

If `constraints.inputOutpoints` explicitly includes an indexed zero-balance holder output, Kit refuses the request rather than silently replacing or omitting it. The standard Provider returns:

```json
{
  "code": -32602,
  "message": "An explicitly selected token input has zero balance",
  "data": {
    "operation": "chainData.resolve",
    "portError": "INVALID_INPUT",
    "reason": "SELECTED_ZERO_BALANCE_INPUT",
    "retryable": false
  }
}
```

Present this to the caller and request a corrected explicit input set. Do not silently retry without the selected input. This patch does not introduce a zero-token-output recovery/cleanup operation, change existing selection bounds, or loosen balance, fee, approval or signing requirements.
