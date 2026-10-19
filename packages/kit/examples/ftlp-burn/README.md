# Public FTLP burn example

`wallet.tbc20Lp.burn({ poolContractId })` asks the wallet to select one
to five complete, eligible FTLP UTXOs and irreversibly send their exact combined
balance to `1BitcoinEaterAddressDontSendf59kuE`.

The shared entry supports this operation only for eligible historical FTLP.
It does not introduce an independent burn operation for current AMM LP; an
unsupported template is rejected rather than rerouted after failure.

This is not liquidity removal or Pool closure: it does not spend the current
Pool state and returns no TBC or FT reserves. The approval must show the exact LP
amount, fixed eater destination, fee, Pool identity, and irreversible effect.
Locked-family FTLP is eligible only after it has already been converted to the
released zero-lock form.
