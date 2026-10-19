# Released Pool NFT v2 ASM sources

These files are byte-for-byte copies from `tbc-contract-go` commit
`fea64e67eedec31f014292e39ebbbee368d7edb3`:

| Local file | Upstream path | SHA-256 |
| --- | --- | --- |
| `pool_code.asm` | `lib/contract/asm/poolnft2_code.asm` | `4b4ea776d5657dacacc27b18cfaf7e44f9a7f9defff4c4116e9ef3e22d56d55a` |
| `pool_code_locked_pre.asm` | `lib/contract/asm/poolnft2_lock_code_pre.asm` | `cb35426428e8a145da37594485ddca7407e66855cd4eb84d4f30353c4a06e946` |
| `pool_code_locked_last.asm` | `lib/contract/asm/poolnft2_lock_code_last.asm` | `7429997c94d8ad0573e239fdc6cf5a8ebe210b34c772c0f720c6c35c31619808` |
| `ftlp_code.asm` | `lib/contract/asm/poolnft2_ftlp_code.asm` | `18478f9753f655df20cbffc74c05ca335a708a600c3c5787299af9976643f44b` |
| `ftlp_code_lock_time.asm` | `lib/contract/asm/poolnft2_ftlp_locktime_code.asm` | `c9eadf3a9d6984f19b957fe52f84f2d01e72e3cdc0769d1d9d42e212c03cc6bf` |

`scripts/generate-pool-v2-js-fixtures.js` additionally checks these hashes before
loading `tbc-contract` 1.6.5 and `tbc-lib-js` 1.0.31 to generate the parity fixture.
