export const TBC_NODE_SOURCE = Object.freeze({
  repository: "https://github.com/TuringBitChain/TBCNODE",
  release: "v3.3.1",
  commit: "6ddea88c57e9bc9390c1730657ac766b56c4a670",
  publishedAt: "2026-08-12T08:42:14Z",
} as const);

export const TBC_RPC_METHODS = Object.freeze([
  {
    "category": "wallet",
    "method": "abandontransaction",
    "args": [
      "txid"
    ],
    "profile": "wallet",
    "effect": "write",
    "source": "src/wallet/rpcwallet.cpp"
  },
  {
    "category": "wallet",
    "method": "addmultisigaddress",
    "args": [
      "nrequired",
      "keys",
      "account"
    ],
    "profile": "wallet",
    "effect": "write",
    "source": "src/wallet/rpcwallet.cpp"
  },
  {
    "category": "network",
    "method": "addnode",
    "args": [
      "node",
      "command"
    ],
    "profile": "node",
    "effect": "write",
    "source": "src/rpc/net.cpp"
  },
  {
    "category": "wallet",
    "method": "backupwallet",
    "args": [
      "destination"
    ],
    "profile": "wallet",
    "effect": "write",
    "source": "src/wallet/rpcwallet.cpp"
  },
  {
    "category": "blockchain",
    "method": "checkjournal",
    "args": [],
    "profile": "node",
    "effect": "read",
    "source": "src/rpc/blockchain.cpp"
  },
  {
    "category": "network",
    "method": "clearbanned",
    "args": [],
    "profile": "node",
    "effect": "write",
    "source": "src/rpc/net.cpp"
  },
  {
    "category": "util",
    "method": "createmultisig",
    "args": [
      "nrequired",
      "keys"
    ],
    "profile": "node",
    "effect": "read",
    "source": "src/rpc/misc.cpp"
  },
  {
    "category": "rawtransactions",
    "method": "createrawtransaction",
    "args": [
      "inputs",
      "outputs",
      "locktime"
    ],
    "profile": "node",
    "effect": "read",
    "source": "src/rpc/rawtransaction.cpp"
  },
  {
    "category": "rawtransactions",
    "method": "decoderawtransaction",
    "args": [
      "hexstring"
    ],
    "profile": "node",
    "effect": "read",
    "source": "src/rpc/rawtransaction.cpp"
  },
  {
    "category": "rawtransactions",
    "method": "decodescript",
    "args": [
      "hexstring"
    ],
    "profile": "node",
    "effect": "read",
    "source": "src/rpc/rawtransaction.cpp"
  },
  {
    "category": "network",
    "method": "disconnectnode",
    "args": [
      "address",
      "nodeid"
    ],
    "profile": "node",
    "effect": "write",
    "source": "src/rpc/net.cpp"
  },
  {
    "category": "wallet",
    "method": "dumpprivkey",
    "args": [
      "address"
    ],
    "profile": "wallet",
    "effect": "sensitive",
    "source": "src/wallet/rpcdump.cpp"
  },
  {
    "category": "wallet",
    "method": "dumpwallet",
    "args": [
      "filename"
    ],
    "profile": "wallet",
    "effect": "sensitive",
    "source": "src/wallet/rpcdump.cpp"
  },
  {
    "category": "hidden",
    "method": "echo",
    "args": [
      "arg0",
      "arg1",
      "arg2",
      "arg3",
      "arg4",
      "arg5",
      "arg6",
      "arg7",
      "arg8",
      "arg9"
    ],
    "profile": "node",
    "effect": "read",
    "source": "src/rpc/misc.cpp"
  },
  {
    "category": "hidden",
    "method": "echojson",
    "args": [
      "arg0",
      "arg1",
      "arg2",
      "arg3",
      "arg4",
      "arg5",
      "arg6",
      "arg7",
      "arg8",
      "arg9"
    ],
    "profile": "node",
    "effect": "read",
    "source": "src/rpc/misc.cpp"
  },
  {
    "category": "wallet",
    "method": "encryptwallet",
    "args": [
      "passphrase"
    ],
    "profile": "wallet",
    "effect": "write",
    "source": "src/wallet/rpcwallet.cpp"
  },
  {
    "category": "rawtransactions",
    "method": "fundrawtransaction",
    "args": [
      "hexstring",
      "options"
    ],
    "profile": "wallet",
    "effect": "write",
    "source": "src/wallet/rpcwallet.cpp"
  },
  {
    "category": "generating",
    "method": "generate",
    "args": [
      "nblocks",
      "maxtries"
    ],
    "profile": "wallet",
    "effect": "write",
    "source": "src/wallet/rpcwallet.cpp"
  },
  {
    "category": "generating",
    "method": "generatetoaddress",
    "args": [
      "nblocks",
      "address",
      "maxtries"
    ],
    "profile": "node",
    "effect": "write",
    "source": "src/rpc/mining.cpp"
  },
  {
    "category": "wallet",
    "method": "getaccount",
    "args": [
      "address"
    ],
    "profile": "wallet",
    "effect": "read",
    "source": "src/wallet/rpcwallet.cpp"
  },
  {
    "category": "wallet",
    "method": "getaccountaddress",
    "args": [
      "account"
    ],
    "profile": "wallet",
    "effect": "write",
    "source": "src/wallet/rpcwallet.cpp"
  },
  {
    "category": "network",
    "method": "getaddednodeinfo",
    "args": [
      "node"
    ],
    "profile": "node",
    "effect": "read",
    "source": "src/rpc/net.cpp"
  },
  {
    "category": "wallet",
    "method": "getaddressesbyaccount",
    "args": [
      "account"
    ],
    "profile": "wallet",
    "effect": "read",
    "source": "src/wallet/rpcwallet.cpp"
  },
  {
    "category": "wallet",
    "method": "getbalance",
    "args": [
      "account",
      "minconf",
      "include_watchonly"
    ],
    "profile": "wallet",
    "effect": "read",
    "source": "src/wallet/rpcwallet.cpp"
  },
  {
    "category": "blockchain",
    "method": "getbestblockhash",
    "args": [],
    "profile": "node",
    "effect": "read",
    "source": "src/rpc/blockchain.cpp"
  },
  {
    "category": "blockchain",
    "method": "getblock",
    "args": [
      "blockhash",
      "verbosity|verbose"
    ],
    "profile": "node",
    "effect": "read",
    "source": "src/rpc/blockchain.cpp"
  },
  {
    "category": "blockchain",
    "method": "getblockbyheight",
    "args": [
      "blockhash",
      "verbosity|verbose"
    ],
    "profile": "node",
    "effect": "read",
    "source": "src/rpc/blockchain.cpp"
  },
  {
    "category": "hidden",
    "method": "getblockchainactivity",
    "args": [],
    "profile": "node",
    "effect": "read",
    "source": "src/rpc/blockchain.cpp"
  },
  {
    "category": "blockchain",
    "method": "getblockchaininfo",
    "args": [],
    "profile": "node",
    "effect": "read",
    "source": "src/rpc/blockchain.cpp"
  },
  {
    "category": "blockchain",
    "method": "getblockcount",
    "args": [],
    "profile": "node",
    "effect": "read",
    "source": "src/rpc/blockchain.cpp"
  },
  {
    "category": "blockchain",
    "method": "getblockhash",
    "args": [
      "height"
    ],
    "profile": "node",
    "effect": "read",
    "source": "src/rpc/blockchain.cpp"
  },
  {
    "category": "blockchain",
    "method": "getblockheader",
    "args": [
      "blockhash",
      "verbose"
    ],
    "profile": "node",
    "effect": "read",
    "source": "src/rpc/blockchain.cpp"
  },
  {
    "category": "blockchain",
    "method": "getblockstats",
    "args": [
      "blockhash",
      "stats"
    ],
    "profile": "node",
    "effect": "read",
    "source": "src/rpc/blockchain.cpp"
  },
  {
    "category": "blockchain",
    "method": "getblockstatsbyheight",
    "args": [
      "height",
      "stats"
    ],
    "profile": "node",
    "effect": "read",
    "source": "src/rpc/blockchain.cpp"
  },
  {
    "category": "mining",
    "method": "getblocktemplate",
    "args": [
      "template_request"
    ],
    "profile": "node",
    "effect": "read",
    "source": "src/rpc/mining.cpp"
  },
  {
    "category": "blockchain",
    "method": "getchaintips",
    "args": [],
    "profile": "node",
    "effect": "read",
    "source": "src/rpc/blockchain.cpp"
  },
  {
    "category": "blockchain",
    "method": "getchaintxstats",
    "args": [
      "nblocks",
      "blockhash"
    ],
    "profile": "node",
    "effect": "read",
    "source": "src/rpc/blockchain.cpp"
  },
  {
    "category": "network",
    "method": "getconnectioncount",
    "args": [],
    "profile": "node",
    "effect": "read",
    "source": "src/rpc/net.cpp"
  },
  {
    "category": "hidden",
    "method": "getcurrentlyvalidatingblocks",
    "args": [],
    "profile": "node",
    "effect": "read",
    "source": "src/rpc/blockchain.cpp"
  },
  {
    "category": "blockchain",
    "method": "getdifficulty",
    "args": [],
    "profile": "node",
    "effect": "read",
    "source": "src/rpc/blockchain.cpp"
  },
  {
    "category": "network",
    "method": "getexcessiveblock",
    "args": [],
    "profile": "node",
    "effect": "read",
    "source": "src/rpc/abc.cpp"
  },
  {
    "category": "control",
    "method": "getinfo",
    "args": [],
    "profile": "node",
    "effect": "read",
    "source": "src/rpc/misc.cpp"
  },
  {
    "category": "control",
    "method": "getmemoryinfo",
    "args": [],
    "profile": "node",
    "effect": "read",
    "source": "src/rpc/misc.cpp"
  },
  {
    "category": "blockchain",
    "method": "getmempoolancestors",
    "args": [
      "txid",
      "verbose"
    ],
    "profile": "node",
    "effect": "read",
    "source": "src/rpc/blockchain.cpp"
  },
  {
    "category": "blockchain",
    "method": "getmempooldescendants",
    "args": [
      "txid",
      "verbose"
    ],
    "profile": "node",
    "effect": "read",
    "source": "src/rpc/blockchain.cpp"
  },
  {
    "category": "blockchain",
    "method": "getmempoolentry",
    "args": [
      "txid"
    ],
    "profile": "node",
    "effect": "read",
    "source": "src/rpc/blockchain.cpp"
  },
  {
    "category": "blockchain",
    "method": "getmempoolinfo",
    "args": [],
    "profile": "node",
    "effect": "read",
    "source": "src/rpc/blockchain.cpp"
  },
  {
    "category": "mining",
    "method": "getminingcandidate",
    "args": [
      "coinbase"
    ],
    "profile": "node",
    "effect": "write",
    "source": "src/rpc/mining-fbb.cpp"
  },
  {
    "category": "mining",
    "method": "getmininginfo",
    "args": [],
    "profile": "node",
    "effect": "read",
    "source": "src/rpc/mining.cpp"
  },
  {
    "category": "network",
    "method": "getnettotals",
    "args": [],
    "profile": "node",
    "effect": "read",
    "source": "src/rpc/net.cpp"
  },
  {
    "category": "mining",
    "method": "getnetworkhashps",
    "args": [
      "nblocks",
      "height"
    ],
    "profile": "node",
    "effect": "read",
    "source": "src/rpc/mining.cpp"
  },
  {
    "category": "network",
    "method": "getnetworkinfo",
    "args": [],
    "profile": "node",
    "effect": "read",
    "source": "src/rpc/net.cpp"
  },
  {
    "category": "wallet",
    "method": "getnewaddress",
    "args": [
      "account"
    ],
    "profile": "wallet",
    "effect": "write",
    "source": "src/wallet/rpcwallet.cpp"
  },
  {
    "category": "network",
    "method": "getpeerinfo",
    "args": [],
    "profile": "node",
    "effect": "read",
    "source": "src/rpc/net.cpp"
  },
  {
    "category": "wallet",
    "method": "getrawchangeaddress",
    "args": [],
    "profile": "wallet",
    "effect": "write",
    "source": "src/wallet/rpcwallet.cpp"
  },
  {
    "category": "blockchain",
    "method": "getrawmempool",
    "args": [
      "verbose"
    ],
    "profile": "node",
    "effect": "read",
    "source": "src/rpc/blockchain.cpp"
  },
  {
    "category": "blockchain",
    "method": "getrawnonfinalmempool",
    "args": [],
    "profile": "node",
    "effect": "read",
    "source": "src/rpc/blockchain.cpp"
  },
  {
    "category": "rawtransactions",
    "method": "getrawtransaction",
    "args": [
      "txid",
      "verbose"
    ],
    "profile": "node",
    "effect": "read",
    "source": "src/rpc/rawtransaction.cpp"
  },
  {
    "category": "wallet",
    "method": "getreceivedbyaccount",
    "args": [
      "account",
      "minconf"
    ],
    "profile": "wallet",
    "effect": "read",
    "source": "src/wallet/rpcwallet.cpp"
  },
  {
    "category": "wallet",
    "method": "getreceivedbyaddress",
    "args": [
      "address",
      "minconf"
    ],
    "profile": "wallet",
    "effect": "read",
    "source": "src/wallet/rpcwallet.cpp"
  },
  {
    "category": "wallet",
    "method": "gettransaction",
    "args": [
      "txid",
      "include_watchonly"
    ],
    "profile": "wallet",
    "effect": "read",
    "source": "src/wallet/rpcwallet.cpp"
  },
  {
    "category": "blockchain",
    "method": "gettxout",
    "args": [
      "txid",
      "n",
      "include_mempool"
    ],
    "profile": "node",
    "effect": "read",
    "source": "src/rpc/blockchain.cpp"
  },
  {
    "category": "blockchain",
    "method": "gettxoutproof",
    "args": [
      "txids",
      "blockhash"
    ],
    "profile": "node",
    "effect": "read",
    "source": "src/rpc/rawtransaction.cpp"
  },
  {
    "category": "blockchain",
    "method": "gettxoutsetinfo",
    "args": [],
    "profile": "node",
    "effect": "read",
    "source": "src/rpc/blockchain.cpp"
  },
  {
    "category": "wallet",
    "method": "getunconfirmedbalance",
    "args": [],
    "profile": "wallet",
    "effect": "read",
    "source": "src/wallet/rpcwallet.cpp"
  },
  {
    "category": "hidden",
    "method": "getwaitingblocks",
    "args": [],
    "profile": "node",
    "effect": "read",
    "source": "src/rpc/blockchain.cpp"
  },
  {
    "category": "wallet",
    "method": "getwalletinfo",
    "args": [],
    "profile": "wallet",
    "effect": "read",
    "source": "src/wallet/rpcwallet.cpp"
  },
  {
    "category": "control",
    "method": "help",
    "args": [
      "command"
    ],
    "profile": "node",
    "effect": "read",
    "source": "src/rpc/server.cpp"
  },
  {
    "category": "wallet",
    "method": "importaddress",
    "args": [
      "address",
      "label",
      "rescan",
      "p2sh"
    ],
    "profile": "wallet",
    "effect": "write",
    "source": "src/wallet/rpcdump.cpp"
  },
  {
    "category": "wallet",
    "method": "importmulti",
    "args": [
      "requests",
      "options"
    ],
    "profile": "wallet",
    "effect": "write",
    "source": "src/wallet/rpcdump.cpp"
  },
  {
    "category": "wallet",
    "method": "importprivkey",
    "args": [
      "privkey",
      "label",
      "rescan"
    ],
    "profile": "wallet",
    "effect": "sensitive",
    "source": "src/wallet/rpcdump.cpp"
  },
  {
    "category": "wallet",
    "method": "importprunedfunds",
    "args": [
      "rawtransaction",
      "txoutproof"
    ],
    "profile": "wallet",
    "effect": "write",
    "source": "src/wallet/rpcdump.cpp"
  },
  {
    "category": "wallet",
    "method": "importpubkey",
    "args": [
      "pubkey",
      "label",
      "rescan"
    ],
    "profile": "wallet",
    "effect": "write",
    "source": "src/wallet/rpcdump.cpp"
  },
  {
    "category": "wallet",
    "method": "importwallet",
    "args": [
      "filename"
    ],
    "profile": "wallet",
    "effect": "write",
    "source": "src/wallet/rpcdump.cpp"
  },
  {
    "category": "hidden",
    "method": "invalidateblock",
    "args": [
      "blockhash"
    ],
    "profile": "node",
    "effect": "write",
    "source": "src/rpc/blockchain.cpp"
  },
  {
    "category": "wallet",
    "method": "keypoolrefill",
    "args": [
      "newsize"
    ],
    "profile": "wallet",
    "effect": "write",
    "source": "src/wallet/rpcwallet.cpp"
  },
  {
    "category": "wallet",
    "method": "listaccounts",
    "args": [
      "minconf",
      "include_watchonly"
    ],
    "profile": "wallet",
    "effect": "read",
    "source": "src/wallet/rpcwallet.cpp"
  },
  {
    "category": "wallet",
    "method": "listaddressgroupings",
    "args": [],
    "profile": "wallet",
    "effect": "read",
    "source": "src/wallet/rpcwallet.cpp"
  },
  {
    "category": "network",
    "method": "listbanned",
    "args": [],
    "profile": "node",
    "effect": "read",
    "source": "src/rpc/net.cpp"
  },
  {
    "category": "wallet",
    "method": "listlockunspent",
    "args": [],
    "profile": "wallet",
    "effect": "read",
    "source": "src/wallet/rpcwallet.cpp"
  },
  {
    "category": "wallet",
    "method": "listreceivedbyaccount",
    "args": [
      "minconf",
      "include_empty",
      "include_watchonly"
    ],
    "profile": "wallet",
    "effect": "read",
    "source": "src/wallet/rpcwallet.cpp"
  },
  {
    "category": "wallet",
    "method": "listreceivedbyaddress",
    "args": [
      "minconf",
      "include_empty",
      "include_watchonly"
    ],
    "profile": "wallet",
    "effect": "read",
    "source": "src/wallet/rpcwallet.cpp"
  },
  {
    "category": "wallet",
    "method": "listsinceblock",
    "args": [
      "blockhash",
      "target_confirmations",
      "include_watchonly"
    ],
    "profile": "wallet",
    "effect": "read",
    "source": "src/wallet/rpcwallet.cpp"
  },
  {
    "category": "wallet",
    "method": "listtransactions",
    "args": [
      "account",
      "count",
      "skip",
      "include_watchonly"
    ],
    "profile": "wallet",
    "effect": "read",
    "source": "src/wallet/rpcwallet.cpp"
  },
  {
    "category": "wallet",
    "method": "listunspent",
    "args": [
      "minconf",
      "maxconf",
      "addresses",
      "include_unsafe"
    ],
    "profile": "wallet",
    "effect": "read",
    "source": "src/wallet/rpcwallet.cpp"
  },
  {
    "category": "wallet",
    "method": "listwallets",
    "args": [],
    "profile": "wallet",
    "effect": "read",
    "source": "src/wallet/rpcwallet.cpp"
  },
  {
    "category": "wallet",
    "method": "lockunspent",
    "args": [
      "unlock",
      "transactions"
    ],
    "profile": "wallet",
    "effect": "write",
    "source": "src/wallet/rpcwallet.cpp"
  },
  {
    "category": "wallet",
    "method": "move",
    "args": [
      "fromaccount",
      "toaccount",
      "amount",
      "minconf",
      "comment"
    ],
    "profile": "wallet",
    "effect": "write",
    "source": "src/wallet/rpcwallet.cpp"
  },
  {
    "category": "network",
    "method": "ping",
    "args": [],
    "profile": "node",
    "effect": "write",
    "source": "src/rpc/net.cpp"
  },
  {
    "category": "blockchain",
    "method": "preciousblock",
    "args": [
      "blockhash"
    ],
    "profile": "node",
    "effect": "write",
    "source": "src/rpc/blockchain.cpp"
  },
  {
    "category": "mining",
    "method": "prioritisetransaction",
    "args": [
      "txid",
      "priority_delta",
      "fee_delta"
    ],
    "profile": "node",
    "effect": "write",
    "source": "src/rpc/mining.cpp"
  },
  {
    "category": "blockchain",
    "method": "pruneblockchain",
    "args": [
      "height"
    ],
    "profile": "node",
    "effect": "write",
    "source": "src/rpc/blockchain.cpp"
  },
  {
    "category": "blockchain",
    "method": "rebuildjournal",
    "args": [],
    "profile": "node",
    "effect": "write",
    "source": "src/rpc/blockchain.cpp"
  },
  {
    "category": "hidden",
    "method": "reconsiderblock",
    "args": [
      "blockhash"
    ],
    "profile": "node",
    "effect": "write",
    "source": "src/rpc/blockchain.cpp"
  },
  {
    "category": "wallet",
    "method": "removeprunedfunds",
    "args": [
      "txid"
    ],
    "profile": "wallet",
    "effect": "write",
    "source": "src/wallet/rpcdump.cpp"
  },
  {
    "category": "hidden",
    "method": "resendwallettransactions",
    "args": [],
    "profile": "wallet",
    "effect": "write",
    "source": "src/wallet/rpcwallet.cpp"
  },
  {
    "category": "wallet",
    "method": "sendfrom",
    "args": [
      "fromaccount",
      "toaddress",
      "amount",
      "minconf",
      "comment",
      "comment_to"
    ],
    "profile": "wallet",
    "effect": "write",
    "source": "src/wallet/rpcwallet.cpp"
  },
  {
    "category": "wallet",
    "method": "sendmany",
    "args": [
      "fromaccount",
      "amounts",
      "minconf",
      "comment",
      "subtractfeefrom"
    ],
    "profile": "wallet",
    "effect": "write",
    "source": "src/wallet/rpcwallet.cpp"
  },
  {
    "category": "rawtransactions",
    "method": "sendrawtransaction",
    "args": [
      "hexstring",
      "allowhighfees",
      "dontcheckfee"
    ],
    "profile": "node",
    "effect": "write",
    "source": "src/rpc/rawtransaction.cpp"
  },
  {
    "category": "rawtransactions",
    "method": "sendrawtransactions",
    "args": [
      "inputs"
    ],
    "profile": "node",
    "effect": "write",
    "source": "src/rpc/rawtransaction.cpp"
  },
  {
    "category": "wallet",
    "method": "sendtoaddress",
    "args": [
      "address",
      "amount",
      "comment",
      "comment_to",
      "subtractfeefromamount"
    ],
    "profile": "wallet",
    "effect": "write",
    "source": "src/wallet/rpcwallet.cpp"
  },
  {
    "category": "wallet",
    "method": "setaccount",
    "args": [
      "address",
      "account"
    ],
    "profile": "wallet",
    "effect": "write",
    "source": "src/wallet/rpcwallet.cpp"
  },
  {
    "category": "network",
    "method": "setban",
    "args": [
      "subnet",
      "command",
      "bantime",
      "absolute"
    ],
    "profile": "node",
    "effect": "write",
    "source": "src/rpc/net.cpp"
  },
  {
    "category": "network",
    "method": "setblockmaxsize",
    "args": [
      "maxBlockSize"
    ],
    "profile": "node",
    "effect": "write",
    "source": "src/rpc/abc.cpp"
  },
  {
    "category": "network",
    "method": "setexcessiveblock",
    "args": [
      "maxBlockSize"
    ],
    "profile": "node",
    "effect": "write",
    "source": "src/rpc/abc.cpp"
  },
  {
    "category": "hidden",
    "method": "setmocktime",
    "args": [
      "timestamp"
    ],
    "profile": "node",
    "effect": "write",
    "source": "src/rpc/misc.cpp"
  },
  {
    "category": "network",
    "method": "setnetworkactive",
    "args": [
      "state"
    ],
    "profile": "node",
    "effect": "write",
    "source": "src/rpc/net.cpp"
  },
  {
    "category": "wallet",
    "method": "settxfee",
    "args": [
      "amount"
    ],
    "profile": "wallet",
    "effect": "write",
    "source": "src/wallet/rpcwallet.cpp"
  },
  {
    "category": "network",
    "method": "settxnpropagationfreq",
    "args": [
      "freq"
    ],
    "profile": "node",
    "effect": "write",
    "source": "src/rpc/net.cpp"
  },
  {
    "category": "wallet",
    "method": "signmessage",
    "args": [
      "address",
      "message"
    ],
    "profile": "wallet",
    "effect": "sensitive",
    "source": "src/wallet/rpcwallet.cpp"
  },
  {
    "category": "util",
    "method": "signmessagewithprivkey",
    "args": [
      "privkey",
      "message"
    ],
    "profile": "node",
    "effect": "sensitive",
    "source": "src/rpc/misc.cpp"
  },
  {
    "category": "rawtransactions",
    "method": "signrawtransaction",
    "args": [
      "hexstring",
      "prevtxs",
      "privkeys",
      "sighashtype"
    ],
    "profile": "node",
    "effect": "sensitive",
    "source": "src/rpc/rawtransaction.cpp"
  },
  {
    "category": "control",
    "method": "stop",
    "args": [],
    "profile": "node",
    "effect": "write",
    "source": "src/rpc/server.cpp"
  },
  {
    "category": "mining",
    "method": "submitblock",
    "args": [
      "hexdata",
      "parameters"
    ],
    "profile": "node",
    "effect": "write",
    "source": "src/rpc/mining.cpp"
  },
  {
    "category": "mining",
    "method": "submitminingsolution",
    "args": [],
    "profile": "node",
    "effect": "write",
    "source": "src/rpc/mining-fbb.cpp"
  },
  {
    "category": "control",
    "method": "uptime",
    "args": [],
    "profile": "node",
    "effect": "read",
    "source": "src/rpc/server.cpp"
  },
  {
    "category": "util",
    "method": "validateaddress",
    "args": [
      "address"
    ],
    "profile": "node",
    "effect": "read",
    "source": "src/rpc/misc.cpp"
  },
  {
    "category": "mining",
    "method": "verifyblockcandidate",
    "args": [
      "hexdata",
      "parameters"
    ],
    "profile": "node",
    "effect": "read",
    "source": "src/rpc/mining.cpp"
  },
  {
    "category": "blockchain",
    "method": "verifychain",
    "args": [
      "checklevel",
      "nblocks"
    ],
    "profile": "node",
    "effect": "write",
    "source": "src/rpc/blockchain.cpp"
  },
  {
    "category": "util",
    "method": "verifymessage",
    "args": [
      "address",
      "signature",
      "message"
    ],
    "profile": "node",
    "effect": "read",
    "source": "src/rpc/misc.cpp"
  },
  {
    "category": "blockchain",
    "method": "verifytxoutproof",
    "args": [
      "proof"
    ],
    "profile": "node",
    "effect": "read",
    "source": "src/rpc/rawtransaction.cpp"
  },
  {
    "category": "hidden",
    "method": "waitaftervalidatingblock",
    "args": [
      "blockhash",
      "action"
    ],
    "profile": "node",
    "effect": "read",
    "networks": [
      "regtest"
    ],
    "source": "src/rpc/blockchain.cpp"
  },
  {
    "category": "hidden",
    "method": "waitforblockheight",
    "args": [
      "height",
      "timeout"
    ],
    "profile": "node",
    "effect": "read",
    "source": "src/rpc/blockchain.cpp"
  },
  {
    "category": "hidden",
    "method": "waitfornewblock",
    "args": [
      "timeout"
    ],
    "profile": "node",
    "effect": "read",
    "source": "src/rpc/blockchain.cpp"
  },
  {
    "category": "wallet",
    "method": "walletlock",
    "args": [],
    "profile": "wallet",
    "effect": "write",
    "source": "src/wallet/rpcwallet.cpp"
  },
  {
    "category": "wallet",
    "method": "walletpassphrase",
    "args": [
      "passphrase",
      "timeout"
    ],
    "profile": "wallet",
    "effect": "sensitive",
    "source": "src/wallet/rpcwallet.cpp"
  },
  {
    "category": "wallet",
    "method": "walletpassphrasechange",
    "args": [
      "oldpassphrase",
      "newpassphrase"
    ],
    "profile": "wallet",
    "effect": "sensitive",
    "source": "src/wallet/rpcwallet.cpp"
  }
] as const);

export type TbcRpcMethodDefinition = typeof TBC_RPC_METHODS[number];
export type TbcRpcMethodName = TbcRpcMethodDefinition["method"];
export type TbcNodeRpcMethodName = Extract<TbcRpcMethodDefinition, Readonly<{ profile: "node" }>>["method"];
export type TbcWalletRpcMethodName = Extract<TbcRpcMethodDefinition, Readonly<{ profile: "wallet" }>>["method"];
export type TbcReadRpcMethodName = Extract<TbcRpcMethodDefinition, Readonly<{ effect: "read" }>>["method"];
export type TbcNetworkRestrictedRpcMethodName = Extract<TbcRpcMethodDefinition, Readonly<{ networks: readonly string[] }>>["method"];
