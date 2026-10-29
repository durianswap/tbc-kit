export declare const TBC_NODE_SOURCE: Readonly<{
    readonly repository: "https://github.com/TuringBitChain/TBCNODE";
    readonly release: "v3.3.1";
    readonly commit: "6ddea88c57e9bc9390c1730657ac766b56c4a670";
    readonly publishedAt: "2026-08-12T08:42:14Z";
}>;
export declare const TBC_RPC_METHODS: readonly [{
    readonly category: "wallet";
    readonly method: "abandontransaction";
    readonly args: readonly ["txid"];
    readonly profile: "wallet";
    readonly effect: "write";
    readonly source: "src/wallet/rpcwallet.cpp";
}, {
    readonly category: "wallet";
    readonly method: "addmultisigaddress";
    readonly args: readonly ["nrequired", "keys", "account"];
    readonly profile: "wallet";
    readonly effect: "write";
    readonly source: "src/wallet/rpcwallet.cpp";
}, {
    readonly category: "network";
    readonly method: "addnode";
    readonly args: readonly ["node", "command"];
    readonly profile: "node";
    readonly effect: "write";
    readonly source: "src/rpc/net.cpp";
}, {
    readonly category: "wallet";
    readonly method: "backupwallet";
    readonly args: readonly ["destination"];
    readonly profile: "wallet";
    readonly effect: "write";
    readonly source: "src/wallet/rpcwallet.cpp";
}, {
    readonly category: "blockchain";
    readonly method: "checkjournal";
    readonly args: readonly [];
    readonly profile: "node";
    readonly effect: "read";
    readonly source: "src/rpc/blockchain.cpp";
}, {
    readonly category: "network";
    readonly method: "clearbanned";
    readonly args: readonly [];
    readonly profile: "node";
    readonly effect: "write";
    readonly source: "src/rpc/net.cpp";
}, {
    readonly category: "util";
    readonly method: "createmultisig";
    readonly args: readonly ["nrequired", "keys"];
    readonly profile: "node";
    readonly effect: "read";
    readonly source: "src/rpc/misc.cpp";
}, {
    readonly category: "rawtransactions";
    readonly method: "createrawtransaction";
    readonly args: readonly ["inputs", "outputs", "locktime"];
    readonly profile: "node";
    readonly effect: "read";
    readonly source: "src/rpc/rawtransaction.cpp";
}, {
    readonly category: "rawtransactions";
    readonly method: "decoderawtransaction";
    readonly args: readonly ["hexstring"];
    readonly profile: "node";
    readonly effect: "read";
    readonly source: "src/rpc/rawtransaction.cpp";
}, {
    readonly category: "rawtransactions";
    readonly method: "decodescript";
    readonly args: readonly ["hexstring"];
    readonly profile: "node";
    readonly effect: "read";
    readonly source: "src/rpc/rawtransaction.cpp";
}, {
    readonly category: "network";
    readonly method: "disconnectnode";
    readonly args: readonly ["address", "nodeid"];
    readonly profile: "node";
    readonly effect: "write";
    readonly source: "src/rpc/net.cpp";
}, {
    readonly category: "wallet";
    readonly method: "dumpprivkey";
    readonly args: readonly ["address"];
    readonly profile: "wallet";
    readonly effect: "sensitive";
    readonly source: "src/wallet/rpcdump.cpp";
}, {
    readonly category: "wallet";
    readonly method: "dumpwallet";
    readonly args: readonly ["filename"];
    readonly profile: "wallet";
    readonly effect: "sensitive";
    readonly source: "src/wallet/rpcdump.cpp";
}, {
    readonly category: "hidden";
    readonly method: "echo";
    readonly args: readonly ["arg0", "arg1", "arg2", "arg3", "arg4", "arg5", "arg6", "arg7", "arg8", "arg9"];
    readonly profile: "node";
    readonly effect: "read";
    readonly source: "src/rpc/misc.cpp";
}, {
    readonly category: "hidden";
    readonly method: "echojson";
    readonly args: readonly ["arg0", "arg1", "arg2", "arg3", "arg4", "arg5", "arg6", "arg7", "arg8", "arg9"];
    readonly profile: "node";
    readonly effect: "read";
    readonly source: "src/rpc/misc.cpp";
}, {
    readonly category: "wallet";
    readonly method: "encryptwallet";
    readonly args: readonly ["passphrase"];
    readonly profile: "wallet";
    readonly effect: "write";
    readonly source: "src/wallet/rpcwallet.cpp";
}, {
    readonly category: "rawtransactions";
    readonly method: "fundrawtransaction";
    readonly args: readonly ["hexstring", "options"];
    readonly profile: "wallet";
    readonly effect: "write";
    readonly source: "src/wallet/rpcwallet.cpp";
}, {
    readonly category: "generating";
    readonly method: "generate";
    readonly args: readonly ["nblocks", "maxtries"];
    readonly profile: "wallet";
    readonly effect: "write";
    readonly source: "src/wallet/rpcwallet.cpp";
}, {
    readonly category: "generating";
    readonly method: "generatetoaddress";
    readonly args: readonly ["nblocks", "address", "maxtries"];
    readonly profile: "node";
    readonly effect: "write";
    readonly source: "src/rpc/mining.cpp";
}, {
    readonly category: "wallet";
    readonly method: "getaccount";
    readonly args: readonly ["address"];
    readonly profile: "wallet";
    readonly effect: "read";
    readonly source: "src/wallet/rpcwallet.cpp";
}, {
    readonly category: "wallet";
    readonly method: "getaccountaddress";
    readonly args: readonly ["account"];
    readonly profile: "wallet";
    readonly effect: "write";
    readonly source: "src/wallet/rpcwallet.cpp";
}, {
    readonly category: "network";
    readonly method: "getaddednodeinfo";
    readonly args: readonly ["node"];
    readonly profile: "node";
    readonly effect: "read";
    readonly source: "src/rpc/net.cpp";
}, {
    readonly category: "wallet";
    readonly method: "getaddressesbyaccount";
    readonly args: readonly ["account"];
    readonly profile: "wallet";
    readonly effect: "read";
    readonly source: "src/wallet/rpcwallet.cpp";
}, {
    readonly category: "wallet";
    readonly method: "getbalance";
    readonly args: readonly ["account", "minconf", "include_watchonly"];
    readonly profile: "wallet";
    readonly effect: "read";
    readonly source: "src/wallet/rpcwallet.cpp";
}, {
    readonly category: "blockchain";
    readonly method: "getbestblockhash";
    readonly args: readonly [];
    readonly profile: "node";
    readonly effect: "read";
    readonly source: "src/rpc/blockchain.cpp";
}, {
    readonly category: "blockchain";
    readonly method: "getblock";
    readonly args: readonly ["blockhash", "verbosity|verbose"];
    readonly profile: "node";
    readonly effect: "read";
    readonly source: "src/rpc/blockchain.cpp";
}, {
    readonly category: "blockchain";
    readonly method: "getblockbyheight";
    readonly args: readonly ["blockhash", "verbosity|verbose"];
    readonly profile: "node";
    readonly effect: "read";
    readonly source: "src/rpc/blockchain.cpp";
}, {
    readonly category: "hidden";
    readonly method: "getblockchainactivity";
    readonly args: readonly [];
    readonly profile: "node";
    readonly effect: "read";
    readonly source: "src/rpc/blockchain.cpp";
}, {
    readonly category: "blockchain";
    readonly method: "getblockchaininfo";
    readonly args: readonly [];
    readonly profile: "node";
    readonly effect: "read";
    readonly source: "src/rpc/blockchain.cpp";
}, {
    readonly category: "blockchain";
    readonly method: "getblockcount";
    readonly args: readonly [];
    readonly profile: "node";
    readonly effect: "read";
    readonly source: "src/rpc/blockchain.cpp";
}, {
    readonly category: "blockchain";
    readonly method: "getblockhash";
    readonly args: readonly ["height"];
    readonly profile: "node";
    readonly effect: "read";
    readonly source: "src/rpc/blockchain.cpp";
}, {
    readonly category: "blockchain";
    readonly method: "getblockheader";
    readonly args: readonly ["blockhash", "verbose"];
    readonly profile: "node";
    readonly effect: "read";
    readonly source: "src/rpc/blockchain.cpp";
}, {
    readonly category: "blockchain";
    readonly method: "getblockstats";
    readonly args: readonly ["blockhash", "stats"];
    readonly profile: "node";
    readonly effect: "read";
    readonly source: "src/rpc/blockchain.cpp";
}, {
    readonly category: "blockchain";
    readonly method: "getblockstatsbyheight";
    readonly args: readonly ["height", "stats"];
    readonly profile: "node";
    readonly effect: "read";
    readonly source: "src/rpc/blockchain.cpp";
}, {
    readonly category: "mining";
    readonly method: "getblocktemplate";
    readonly args: readonly ["template_request"];
    readonly profile: "node";
    readonly effect: "read";
    readonly source: "src/rpc/mining.cpp";
}, {
    readonly category: "blockchain";
    readonly method: "getchaintips";
    readonly args: readonly [];
    readonly profile: "node";
    readonly effect: "read";
    readonly source: "src/rpc/blockchain.cpp";
}, {
    readonly category: "blockchain";
    readonly method: "getchaintxstats";
    readonly args: readonly ["nblocks", "blockhash"];
    readonly profile: "node";
    readonly effect: "read";
    readonly source: "src/rpc/blockchain.cpp";
}, {
    readonly category: "network";
    readonly method: "getconnectioncount";
    readonly args: readonly [];
    readonly profile: "node";
    readonly effect: "read";
    readonly source: "src/rpc/net.cpp";
}, {
    readonly category: "hidden";
    readonly method: "getcurrentlyvalidatingblocks";
    readonly args: readonly [];
    readonly profile: "node";
    readonly effect: "read";
    readonly source: "src/rpc/blockchain.cpp";
}, {
    readonly category: "blockchain";
    readonly method: "getdifficulty";
    readonly args: readonly [];
    readonly profile: "node";
    readonly effect: "read";
    readonly source: "src/rpc/blockchain.cpp";
}, {
    readonly category: "network";
    readonly method: "getexcessiveblock";
    readonly args: readonly [];
    readonly profile: "node";
    readonly effect: "read";
    readonly source: "src/rpc/abc.cpp";
}, {
    readonly category: "control";
    readonly method: "getinfo";
    readonly args: readonly [];
    readonly profile: "node";
    readonly effect: "read";
    readonly source: "src/rpc/misc.cpp";
}, {
    readonly category: "control";
    readonly method: "getmemoryinfo";
    readonly args: readonly [];
    readonly profile: "node";
    readonly effect: "read";
    readonly source: "src/rpc/misc.cpp";
}, {
    readonly category: "blockchain";
    readonly method: "getmempoolancestors";
    readonly args: readonly ["txid", "verbose"];
    readonly profile: "node";
    readonly effect: "read";
    readonly source: "src/rpc/blockchain.cpp";
}, {
    readonly category: "blockchain";
    readonly method: "getmempooldescendants";
    readonly args: readonly ["txid", "verbose"];
    readonly profile: "node";
    readonly effect: "read";
    readonly source: "src/rpc/blockchain.cpp";
}, {
    readonly category: "blockchain";
    readonly method: "getmempoolentry";
    readonly args: readonly ["txid"];
    readonly profile: "node";
    readonly effect: "read";
    readonly source: "src/rpc/blockchain.cpp";
}, {
    readonly category: "blockchain";
    readonly method: "getmempoolinfo";
    readonly args: readonly [];
    readonly profile: "node";
    readonly effect: "read";
    readonly source: "src/rpc/blockchain.cpp";
}, {
    readonly category: "mining";
    readonly method: "getminingcandidate";
    readonly args: readonly ["coinbase"];
    readonly profile: "node";
    readonly effect: "write";
    readonly source: "src/rpc/mining-fbb.cpp";
}, {
    readonly category: "mining";
    readonly method: "getmininginfo";
    readonly args: readonly [];
    readonly profile: "node";
    readonly effect: "read";
    readonly source: "src/rpc/mining.cpp";
}, {
    readonly category: "network";
    readonly method: "getnettotals";
    readonly args: readonly [];
    readonly profile: "node";
    readonly effect: "read";
    readonly source: "src/rpc/net.cpp";
}, {
    readonly category: "mining";
    readonly method: "getnetworkhashps";
    readonly args: readonly ["nblocks", "height"];
    readonly profile: "node";
    readonly effect: "read";
    readonly source: "src/rpc/mining.cpp";
}, {
    readonly category: "network";
    readonly method: "getnetworkinfo";
    readonly args: readonly [];
    readonly profile: "node";
    readonly effect: "read";
    readonly source: "src/rpc/net.cpp";
}, {
    readonly category: "wallet";
    readonly method: "getnewaddress";
    readonly args: readonly ["account"];
    readonly profile: "wallet";
    readonly effect: "write";
    readonly source: "src/wallet/rpcwallet.cpp";
}, {
    readonly category: "network";
    readonly method: "getpeerinfo";
    readonly args: readonly [];
    readonly profile: "node";
    readonly effect: "read";
    readonly source: "src/rpc/net.cpp";
}, {
    readonly category: "wallet";
    readonly method: "getrawchangeaddress";
    readonly args: readonly [];
    readonly profile: "wallet";
    readonly effect: "write";
    readonly source: "src/wallet/rpcwallet.cpp";
}, {
    readonly category: "blockchain";
    readonly method: "getrawmempool";
    readonly args: readonly ["verbose"];
    readonly profile: "node";
    readonly effect: "read";
    readonly source: "src/rpc/blockchain.cpp";
}, {
    readonly category: "blockchain";
    readonly method: "getrawnonfinalmempool";
    readonly args: readonly [];
    readonly profile: "node";
    readonly effect: "read";
    readonly source: "src/rpc/blockchain.cpp";
}, {
    readonly category: "rawtransactions";
    readonly method: "getrawtransaction";
    readonly args: readonly ["txid", "verbose"];
    readonly profile: "node";
    readonly effect: "read";
    readonly source: "src/rpc/rawtransaction.cpp";
}, {
    readonly category: "wallet";
    readonly method: "getreceivedbyaccount";
    readonly args: readonly ["account", "minconf"];
    readonly profile: "wallet";
    readonly effect: "read";
    readonly source: "src/wallet/rpcwallet.cpp";
}, {
    readonly category: "wallet";
    readonly method: "getreceivedbyaddress";
    readonly args: readonly ["address", "minconf"];
    readonly profile: "wallet";
    readonly effect: "read";
    readonly source: "src/wallet/rpcwallet.cpp";
}, {
    readonly category: "wallet";
    readonly method: "gettransaction";
    readonly args: readonly ["txid", "include_watchonly"];
    readonly profile: "wallet";
    readonly effect: "read";
    readonly source: "src/wallet/rpcwallet.cpp";
}, {
    readonly category: "blockchain";
    readonly method: "gettxout";
    readonly args: readonly ["txid", "n", "include_mempool"];
    readonly profile: "node";
    readonly effect: "read";
    readonly source: "src/rpc/blockchain.cpp";
}, {
    readonly category: "blockchain";
    readonly method: "gettxoutproof";
    readonly args: readonly ["txids", "blockhash"];
    readonly profile: "node";
    readonly effect: "read";
    readonly source: "src/rpc/rawtransaction.cpp";
}, {
    readonly category: "blockchain";
    readonly method: "gettxoutsetinfo";
    readonly args: readonly [];
    readonly profile: "node";
    readonly effect: "read";
    readonly source: "src/rpc/blockchain.cpp";
}, {
    readonly category: "wallet";
    readonly method: "getunconfirmedbalance";
    readonly args: readonly [];
    readonly profile: "wallet";
    readonly effect: "read";
    readonly source: "src/wallet/rpcwallet.cpp";
}, {
    readonly category: "hidden";
    readonly method: "getwaitingblocks";
    readonly args: readonly [];
    readonly profile: "node";
    readonly effect: "read";
    readonly source: "src/rpc/blockchain.cpp";
}, {
    readonly category: "wallet";
    readonly method: "getwalletinfo";
    readonly args: readonly [];
    readonly profile: "wallet";
    readonly effect: "read";
    readonly source: "src/wallet/rpcwallet.cpp";
}, {
    readonly category: "control";
    readonly method: "help";
    readonly args: readonly ["command"];
    readonly profile: "node";
    readonly effect: "read";
    readonly source: "src/rpc/server.cpp";
}, {
    readonly category: "wallet";
    readonly method: "importaddress";
    readonly args: readonly ["address", "label", "rescan", "p2sh"];
    readonly profile: "wallet";
    readonly effect: "write";
    readonly source: "src/wallet/rpcdump.cpp";
}, {
    readonly category: "wallet";
    readonly method: "importmulti";
    readonly args: readonly ["requests", "options"];
    readonly profile: "wallet";
    readonly effect: "write";
    readonly source: "src/wallet/rpcdump.cpp";
}, {
    readonly category: "wallet";
    readonly method: "importprivkey";
    readonly args: readonly ["privkey", "label", "rescan"];
    readonly profile: "wallet";
    readonly effect: "sensitive";
    readonly source: "src/wallet/rpcdump.cpp";
}, {
    readonly category: "wallet";
    readonly method: "importprunedfunds";
    readonly args: readonly ["rawtransaction", "txoutproof"];
    readonly profile: "wallet";
    readonly effect: "write";
    readonly source: "src/wallet/rpcdump.cpp";
}, {
    readonly category: "wallet";
    readonly method: "importpubkey";
    readonly args: readonly ["pubkey", "label", "rescan"];
    readonly profile: "wallet";
    readonly effect: "write";
    readonly source: "src/wallet/rpcdump.cpp";
}, {
    readonly category: "wallet";
    readonly method: "importwallet";
    readonly args: readonly ["filename"];
    readonly profile: "wallet";
    readonly effect: "write";
    readonly source: "src/wallet/rpcdump.cpp";
}, {
    readonly category: "hidden";
    readonly method: "invalidateblock";
    readonly args: readonly ["blockhash"];
    readonly profile: "node";
    readonly effect: "write";
    readonly source: "src/rpc/blockchain.cpp";
}, {
    readonly category: "wallet";
    readonly method: "keypoolrefill";
    readonly args: readonly ["newsize"];
    readonly profile: "wallet";
    readonly effect: "write";
    readonly source: "src/wallet/rpcwallet.cpp";
}, {
    readonly category: "wallet";
    readonly method: "listaccounts";
    readonly args: readonly ["minconf", "include_watchonly"];
    readonly profile: "wallet";
    readonly effect: "read";
    readonly source: "src/wallet/rpcwallet.cpp";
}, {
    readonly category: "wallet";
    readonly method: "listaddressgroupings";
    readonly args: readonly [];
    readonly profile: "wallet";
    readonly effect: "read";
    readonly source: "src/wallet/rpcwallet.cpp";
}, {
    readonly category: "network";
    readonly method: "listbanned";
    readonly args: readonly [];
    readonly profile: "node";
    readonly effect: "read";
    readonly source: "src/rpc/net.cpp";
}, {
    readonly category: "wallet";
    readonly method: "listlockunspent";
    readonly args: readonly [];
    readonly profile: "wallet";
    readonly effect: "read";
    readonly source: "src/wallet/rpcwallet.cpp";
}, {
    readonly category: "wallet";
    readonly method: "listreceivedbyaccount";
    readonly args: readonly ["minconf", "include_empty", "include_watchonly"];
    readonly profile: "wallet";
    readonly effect: "read";
    readonly source: "src/wallet/rpcwallet.cpp";
}, {
    readonly category: "wallet";
    readonly method: "listreceivedbyaddress";
    readonly args: readonly ["minconf", "include_empty", "include_watchonly"];
    readonly profile: "wallet";
    readonly effect: "read";
    readonly source: "src/wallet/rpcwallet.cpp";
}, {
    readonly category: "wallet";
    readonly method: "listsinceblock";
    readonly args: readonly ["blockhash", "target_confirmations", "include_watchonly"];
    readonly profile: "wallet";
    readonly effect: "read";
    readonly source: "src/wallet/rpcwallet.cpp";
}, {
    readonly category: "wallet";
    readonly method: "listtransactions";
    readonly args: readonly ["account", "count", "skip", "include_watchonly"];
    readonly profile: "wallet";
    readonly effect: "read";
    readonly source: "src/wallet/rpcwallet.cpp";
}, {
    readonly category: "wallet";
    readonly method: "listunspent";
    readonly args: readonly ["minconf", "maxconf", "addresses", "include_unsafe"];
    readonly profile: "wallet";
    readonly effect: "read";
    readonly source: "src/wallet/rpcwallet.cpp";
}, {
    readonly category: "wallet";
    readonly method: "listwallets";
    readonly args: readonly [];
    readonly profile: "wallet";
    readonly effect: "read";
    readonly source: "src/wallet/rpcwallet.cpp";
}, {
    readonly category: "wallet";
    readonly method: "lockunspent";
    readonly args: readonly ["unlock", "transactions"];
    readonly profile: "wallet";
    readonly effect: "write";
    readonly source: "src/wallet/rpcwallet.cpp";
}, {
    readonly category: "wallet";
    readonly method: "move";
    readonly args: readonly ["fromaccount", "toaccount", "amount", "minconf", "comment"];
    readonly profile: "wallet";
    readonly effect: "write";
    readonly source: "src/wallet/rpcwallet.cpp";
}, {
    readonly category: "network";
    readonly method: "ping";
    readonly args: readonly [];
    readonly profile: "node";
    readonly effect: "write";
    readonly source: "src/rpc/net.cpp";
}, {
    readonly category: "blockchain";
    readonly method: "preciousblock";
    readonly args: readonly ["blockhash"];
    readonly profile: "node";
    readonly effect: "write";
    readonly source: "src/rpc/blockchain.cpp";
}, {
    readonly category: "mining";
    readonly method: "prioritisetransaction";
    readonly args: readonly ["txid", "priority_delta", "fee_delta"];
    readonly profile: "node";
    readonly effect: "write";
    readonly source: "src/rpc/mining.cpp";
}, {
    readonly category: "blockchain";
    readonly method: "pruneblockchain";
    readonly args: readonly ["height"];
    readonly profile: "node";
    readonly effect: "write";
    readonly source: "src/rpc/blockchain.cpp";
}, {
    readonly category: "blockchain";
    readonly method: "rebuildjournal";
    readonly args: readonly [];
    readonly profile: "node";
    readonly effect: "write";
    readonly source: "src/rpc/blockchain.cpp";
}, {
    readonly category: "hidden";
    readonly method: "reconsiderblock";
    readonly args: readonly ["blockhash"];
    readonly profile: "node";
    readonly effect: "write";
    readonly source: "src/rpc/blockchain.cpp";
}, {
    readonly category: "wallet";
    readonly method: "removeprunedfunds";
    readonly args: readonly ["txid"];
    readonly profile: "wallet";
    readonly effect: "write";
    readonly source: "src/wallet/rpcdump.cpp";
}, {
    readonly category: "hidden";
    readonly method: "resendwallettransactions";
    readonly args: readonly [];
    readonly profile: "wallet";
    readonly effect: "write";
    readonly source: "src/wallet/rpcwallet.cpp";
}, {
    readonly category: "wallet";
    readonly method: "sendfrom";
    readonly args: readonly ["fromaccount", "toaddress", "amount", "minconf", "comment", "comment_to"];
    readonly profile: "wallet";
    readonly effect: "write";
    readonly source: "src/wallet/rpcwallet.cpp";
}, {
    readonly category: "wallet";
    readonly method: "sendmany";
    readonly args: readonly ["fromaccount", "amounts", "minconf", "comment", "subtractfeefrom"];
    readonly profile: "wallet";
    readonly effect: "write";
    readonly source: "src/wallet/rpcwallet.cpp";
}, {
    readonly category: "rawtransactions";
    readonly method: "sendrawtransaction";
    readonly args: readonly ["hexstring", "allowhighfees", "dontcheckfee"];
    readonly profile: "node";
    readonly effect: "write";
    readonly source: "src/rpc/rawtransaction.cpp";
}, {
    readonly category: "rawtransactions";
    readonly method: "sendrawtransactions";
    readonly args: readonly ["inputs"];
    readonly profile: "node";
    readonly effect: "write";
    readonly source: "src/rpc/rawtransaction.cpp";
}, {
    readonly category: "wallet";
    readonly method: "sendtoaddress";
    readonly args: readonly ["address", "amount", "comment", "comment_to", "subtractfeefromamount"];
    readonly profile: "wallet";
    readonly effect: "write";
    readonly source: "src/wallet/rpcwallet.cpp";
}, {
    readonly category: "wallet";
    readonly method: "setaccount";
    readonly args: readonly ["address", "account"];
    readonly profile: "wallet";
    readonly effect: "write";
    readonly source: "src/wallet/rpcwallet.cpp";
}, {
    readonly category: "network";
    readonly method: "setban";
    readonly args: readonly ["subnet", "command", "bantime", "absolute"];
    readonly profile: "node";
    readonly effect: "write";
    readonly source: "src/rpc/net.cpp";
}, {
    readonly category: "network";
    readonly method: "setblockmaxsize";
    readonly args: readonly ["maxBlockSize"];
    readonly profile: "node";
    readonly effect: "write";
    readonly source: "src/rpc/abc.cpp";
}, {
    readonly category: "network";
    readonly method: "setexcessiveblock";
    readonly args: readonly ["maxBlockSize"];
    readonly profile: "node";
    readonly effect: "write";
    readonly source: "src/rpc/abc.cpp";
}, {
    readonly category: "hidden";
    readonly method: "setmocktime";
    readonly args: readonly ["timestamp"];
    readonly profile: "node";
    readonly effect: "write";
    readonly source: "src/rpc/misc.cpp";
}, {
    readonly category: "network";
    readonly method: "setnetworkactive";
    readonly args: readonly ["state"];
    readonly profile: "node";
    readonly effect: "write";
    readonly source: "src/rpc/net.cpp";
}, {
    readonly category: "wallet";
    readonly method: "settxfee";
    readonly args: readonly ["amount"];
    readonly profile: "wallet";
    readonly effect: "write";
    readonly source: "src/wallet/rpcwallet.cpp";
}, {
    readonly category: "network";
    readonly method: "settxnpropagationfreq";
    readonly args: readonly ["freq"];
    readonly profile: "node";
    readonly effect: "write";
    readonly source: "src/rpc/net.cpp";
}, {
    readonly category: "wallet";
    readonly method: "signmessage";
    readonly args: readonly ["address", "message"];
    readonly profile: "wallet";
    readonly effect: "sensitive";
    readonly source: "src/wallet/rpcwallet.cpp";
}, {
    readonly category: "util";
    readonly method: "signmessagewithprivkey";
    readonly args: readonly ["privkey", "message"];
    readonly profile: "node";
    readonly effect: "sensitive";
    readonly source: "src/rpc/misc.cpp";
}, {
    readonly category: "rawtransactions";
    readonly method: "signrawtransaction";
    readonly args: readonly ["hexstring", "prevtxs", "privkeys", "sighashtype"];
    readonly profile: "node";
    readonly effect: "sensitive";
    readonly source: "src/rpc/rawtransaction.cpp";
}, {
    readonly category: "control";
    readonly method: "stop";
    readonly args: readonly [];
    readonly profile: "node";
    readonly effect: "write";
    readonly source: "src/rpc/server.cpp";
}, {
    readonly category: "mining";
    readonly method: "submitblock";
    readonly args: readonly ["hexdata", "parameters"];
    readonly profile: "node";
    readonly effect: "write";
    readonly source: "src/rpc/mining.cpp";
}, {
    readonly category: "mining";
    readonly method: "submitminingsolution";
    readonly args: readonly [];
    readonly profile: "node";
    readonly effect: "write";
    readonly source: "src/rpc/mining-fbb.cpp";
}, {
    readonly category: "control";
    readonly method: "uptime";
    readonly args: readonly [];
    readonly profile: "node";
    readonly effect: "read";
    readonly source: "src/rpc/server.cpp";
}, {
    readonly category: "util";
    readonly method: "validateaddress";
    readonly args: readonly ["address"];
    readonly profile: "node";
    readonly effect: "read";
    readonly source: "src/rpc/misc.cpp";
}, {
    readonly category: "mining";
    readonly method: "verifyblockcandidate";
    readonly args: readonly ["hexdata", "parameters"];
    readonly profile: "node";
    readonly effect: "read";
    readonly source: "src/rpc/mining.cpp";
}, {
    readonly category: "blockchain";
    readonly method: "verifychain";
    readonly args: readonly ["checklevel", "nblocks"];
    readonly profile: "node";
    readonly effect: "write";
    readonly source: "src/rpc/blockchain.cpp";
}, {
    readonly category: "util";
    readonly method: "verifymessage";
    readonly args: readonly ["address", "signature", "message"];
    readonly profile: "node";
    readonly effect: "read";
    readonly source: "src/rpc/misc.cpp";
}, {
    readonly category: "blockchain";
    readonly method: "verifytxoutproof";
    readonly args: readonly ["proof"];
    readonly profile: "node";
    readonly effect: "read";
    readonly source: "src/rpc/rawtransaction.cpp";
}, {
    readonly category: "hidden";
    readonly method: "waitaftervalidatingblock";
    readonly args: readonly ["blockhash", "action"];
    readonly profile: "node";
    readonly effect: "read";
    readonly networks: readonly ["regtest"];
    readonly source: "src/rpc/blockchain.cpp";
}, {
    readonly category: "hidden";
    readonly method: "waitforblockheight";
    readonly args: readonly ["height", "timeout"];
    readonly profile: "node";
    readonly effect: "read";
    readonly source: "src/rpc/blockchain.cpp";
}, {
    readonly category: "hidden";
    readonly method: "waitfornewblock";
    readonly args: readonly ["timeout"];
    readonly profile: "node";
    readonly effect: "read";
    readonly source: "src/rpc/blockchain.cpp";
}, {
    readonly category: "wallet";
    readonly method: "walletlock";
    readonly args: readonly [];
    readonly profile: "wallet";
    readonly effect: "write";
    readonly source: "src/wallet/rpcwallet.cpp";
}, {
    readonly category: "wallet";
    readonly method: "walletpassphrase";
    readonly args: readonly ["passphrase", "timeout"];
    readonly profile: "wallet";
    readonly effect: "sensitive";
    readonly source: "src/wallet/rpcwallet.cpp";
}, {
    readonly category: "wallet";
    readonly method: "walletpassphrasechange";
    readonly args: readonly ["oldpassphrase", "newpassphrase"];
    readonly profile: "wallet";
    readonly effect: "sensitive";
    readonly source: "src/wallet/rpcwallet.cpp";
}];
export type TbcRpcMethodDefinition = typeof TBC_RPC_METHODS[number];
export type TbcRpcMethodName = TbcRpcMethodDefinition["method"];
export type TbcNodeRpcMethodName = Extract<TbcRpcMethodDefinition, Readonly<{
    profile: "node";
}>>["method"];
export type TbcWalletRpcMethodName = Extract<TbcRpcMethodDefinition, Readonly<{
    profile: "wallet";
}>>["method"];
export type TbcReadRpcMethodName = Extract<TbcRpcMethodDefinition, Readonly<{
    effect: "read";
}>>["method"];
export type TbcNetworkRestrictedRpcMethodName = Extract<TbcRpcMethodDefinition, Readonly<{
    networks: readonly string[];
}>>["method"];
//# sourceMappingURL=rpc-catalog.d.ts.map