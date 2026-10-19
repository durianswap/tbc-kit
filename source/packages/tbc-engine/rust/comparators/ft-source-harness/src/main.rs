use std::collections::BTreeMap;
use std::io::Read;

use serde_json::{Value, json};
use tbc_transaction_engine::{build_ft_transaction_json, build_merge_batch_json, dispatch_json};
use tbc_sdk::{
    DEFAULT_SEQUENCE, DEFAULT_SIGHASH, Ft, FtReceiver, FtUtxo, OutPoint, PrivateKey,
    Transaction, TxIn, TxOut, Txid, Utxo,
    contracts::ft::{
        scripts::{FT_CODE_SATOSHIS, FtMintVersion},
        unlock::pre_pre_tx_data_from_parents,
    },
    script::Script,
    sighash::forkid_sighash,
};

const PIN: &str = "923497e8b2473c0e179fa0b86dbb32a2f188d25a";
type PreviousOutputs = BTreeMap<(String, u32), (Script, u64)>;

fn key(last_byte: u8) -> PrivateKey {
    let mut bytes = [0u8; 32];
    bytes[31] = last_byte;
    PrivateKey::from_slice(&bytes).expect("fixed comparator key must be valid")
}

fn funding_parent(marker: u8, satoshis: u64, owner: &PrivateKey) -> Transaction {
    Transaction {
        version: tbc_sdk::TX_VERSION,
        inputs: vec![TxIn {
            previous_output: OutPoint {
                txid: Txid::from_le_bytes([marker; 32]),
                vout: marker as u32,
            },
            script_sig: Script::from_bytes(vec![0x51, marker]),
            sequence: DEFAULT_SEQUENCE,
        }],
        outputs: vec![TxOut {
            satoshis,
            script_pubkey: owner.address().script_pubkey(),
        }],
        lock_time: marker as u32,
    }
}

fn utxo(parent: &Transaction, owner: &PrivateKey) -> Utxo {
    Utxo {
        outpoint: OutPoint { txid: parent.txid(), vout: 0 },
        satoshis: parent.outputs[0].satoshis,
        script_pubkey: parent.outputs[0].script_pubkey.clone(),
        private_key: owner.clone(),
    }
}

fn parent_json(tx: &Transaction) -> Value {
    json!({
        "txid": tx.txid().to_string(),
        "rawTransaction": tx.to_hex(),
        "vout": 0,
        "satoshis": tx.outputs[0].satoshis.to_string(),
        "scriptPubKey": hex::encode(tx.outputs[0].script_pubkey.as_bytes())
    })
}

fn fee_utxo_json(parent: &Transaction) -> Value {
    json!({
        "txid": parent.txid().to_string(),
        "outputIndex": 0,
        "satoshis": parent.outputs[0].satoshis,
        "script": hex::encode(parent.outputs[0].script_pubkey.as_bytes())
    })
}

fn ft_info_json(ft: &Ft) -> Value {
    json!({
        "name": ft.name,
        "symbol": ft.symbol,
        "decimal": ft.decimal,
        "totalSupplyRaw": ft.total_supply_raw.to_string(),
        "contractTxid": ft.contract_txid,
        "codeScript": ft.code_script,
        "tapeScript": ft.tape_script
    })
}

fn ft_utxo_json(utxo: &FtUtxo) -> Value {
    json!({
        "txid": utxo.base.outpoint.txid.to_string(),
        "outputIndex": utxo.base.outpoint.vout,
        "satoshis": utxo.base.satoshis,
        "script": hex::encode(utxo.base.script_pubkey.as_bytes()),
        "ftBalanceRaw": utxo.ft_balance_raw.to_string()
    })
}

fn wrapper_ft_transactions(request: Value) -> Vec<String> {
    let response: Value = serde_json::from_str(
        &build_ft_transaction_json(&request.to_string()).expect("pinned FT wrapper must execute"),
    ).expect("pinned FT wrapper must return JSON");
    response["transactions"].as_array().expect("wrapper transactions must be an array")
        .iter().map(|entry| entry["txraw"].as_str().expect("wrapper txraw").to_owned()).collect()
}

fn register(tx: &Transaction, previous: &mut PreviousOutputs) {
    let txid = tx.txid().to_string();
    for (index, output) in tx.outputs.iter().enumerate() {
        previous.insert((txid.clone(), index as u32), (output.script_pubkey.clone(), output.satoshis));
    }
}

fn transaction_json(tx: &Transaction, previous: &PreviousOutputs) -> Value {
    let mut input_sum = 0u64;
    let digests = tx.inputs.iter().enumerate().map(|(index, input)| {
        let key = (input.previous_output.txid.to_string(), input.previous_output.vout);
        let (script, satoshis) = previous.get(&key)
            .unwrap_or_else(|| panic!("missing authoritative previous output {key:?}"));
        input_sum = input_sum.checked_add(*satoshis).expect("input sum overflow");
        hex::encode(forkid_sighash(tx, index, script, *satoshis, DEFAULT_SIGHASH)
            .expect("pinned SDK sighash must succeed"))
    }).collect::<Vec<_>>();
    let output_sum = tx.outputs.iter()
        .try_fold(0u64, |sum, output| sum.checked_add(output.satoshis))
        .expect("output sum overflow");
    let mut unsigned = tx.clone();
    for input in &mut unsigned.inputs {
        input.script_sig = Script::empty();
    }
    json!({
        "unsignedTransaction": unsigned.to_hex(),
        "rawTransaction": tx.to_hex(),
        "txid": tx.txid().to_string(),
        "fee": (input_sum - output_sum).to_string(),
        "digests": digests,
        "inputCount": tx.inputs.len(),
        "outputCount": tx.outputs.len(),
        "inputs": tx.inputs.iter().map(|input| json!({
            "txid": input.previous_output.txid.to_string(),
            "vout": input.previous_output.vout,
            "sequence": input.sequence,
            "signature": hex::encode(input.script_sig.as_bytes())
        })).collect::<Vec<_>>(),
        "outputs": tx.outputs.iter().map(|output| json!({
            "satoshis": output.satoshis.to_string(),
            "script": hex::encode(output.script_pubkey.as_bytes())
        })).collect::<Vec<_>>(),
        "outputScripts": tx.outputs.iter().map(|output| hex::encode(output.script_pubkey.as_bytes())).collect::<Vec<_>>(),
        "signatures": tx.inputs.iter().map(|input| hex::encode(input.script_sig.as_bytes())).collect::<Vec<_>>()
    })
}

fn main() {
    if std::env::args().nth(1).as_deref() == Some("--describe") {
        let mut request = String::new();
        std::io::stdin().read_to_string(&mut request).expect("read describe request");
        let request: Value = serde_json::from_str(&request).expect("describe request JSON");
        let transaction = Transaction::from_hex(
            request["rawTransaction"].as_str().expect("describe rawTransaction"),
        ).expect("describe transaction must parse");
        let supplied = request["previousOutputs"].as_array().expect("describe previousOutputs");
        assert_eq!(supplied.len(), transaction.inputs.len(), "one previous output per input");
        let mut previous = PreviousOutputs::new();
        for (input, output) in transaction.inputs.iter().zip(supplied) {
            previous.insert(
                (input.previous_output.txid.to_string(), input.previous_output.vout),
                (
                    Script::from_bytes(hex::decode(output["script"].as_str().expect("previous script")).expect("previous script hex")),
                    output["satoshis"].as_u64().expect("previous satoshis"),
                ),
            );
        }
        println!("{}", transaction_json(&transaction, &previous));
        return;
    }
    if let Some(operation) = std::env::args().nth(2).filter(|_| {
        std::env::args().nth(1).as_deref() == Some("--dispatch")
    }) {
        let mut request = String::new();
        std::io::stdin()
            .read_to_string(&mut request)
            .expect("read dispatch request");
        println!(
            "{}",
            dispatch_json(&operation, &request).expect("pinned engine dispatch must succeed")
        );
        return;
    }
    let owner = key(1);
    let recipient = key(2);
    let mint_funding_parent = funding_parent(0x11, 1_000_000, &owner);
    let direct_fee_parent = funding_parent(0x22, 1_000_000, &owner);
    let distribution_fee_parent = funding_parent(0x33, 2_000_000, &owner);
    let merge_fee_parent = funding_parent(0x44, 10_000_000, &owner);
    let transfer_chain_fee_parent = funding_parent(0x45, 10_000_000, &owner);

    let mut ft = Ft::new("Comparator Token".to_owned(), "CMP".to_owned(), 600, 0)
        .expect("valid comparator FT metadata");
    let minted = ft.mint_ft_with_version(
        owner.clone(), owner.address(), utxo(&mint_funding_parent, &owner), FtMintVersion::V4,
    ).expect("pinned V4 mint builder must execute");
    let mint_proof = pre_pre_tx_data_from_parents(&minted.mint, 0, &[minted.source.clone()])
        .expect("mint ancestry must be encodable");
    let mint_utxo = FtUtxo {
        base: Utxo {
            outpoint: OutPoint { txid: minted.mint.txid(), vout: 0 },
            satoshis: minted.mint.outputs[0].satoshis,
            script_pubkey: minted.mint.outputs[0].script_pubkey.clone(),
            private_key: owner.clone(),
        },
        ft_balance_raw: 600,
    };
    let direct = ft.transfer(
        owner.clone(), recipient.address(), 200, vec![mint_utxo.clone()],
        utxo(&direct_fee_parent, &owner), vec![minted.mint.clone()], vec![mint_proof.clone()], None,
    ).expect("pinned direct transfer builder must execute");
    let wrapper_key = owner.to_wif();
    let wrapper_mint = wrapper_ft_transactions(json!({
        "operation": "mint",
        "privateKeyWif": wrapper_key,
        "asset": {
            "name": "Comparator Token", "symbol": "CMP", "decimal": 0,
            "totalSupplyRaw": "600"
        },
        "recipient": owner.address().to_string(),
        "funding": fee_utxo_json(&mint_funding_parent)
    }));
    assert_eq!(wrapper_mint, vec![minted.source.to_hex(), minted.mint.to_hex()]);
    let wrapper_direct = wrapper_ft_transactions(json!({
        "operation": "transfer",
        "privateKeyWif": wrapper_key,
        "asset": ft_info_json(&ft),
        "recipient": recipient.address().to_string(),
        "amountRaw": "200",
        "assetUtxos": [ft_utxo_json(&mint_utxo)],
        "feeUtxo": fee_utxo_json(&direct_fee_parent),
        "preTxs": [minted.mint.to_hex()],
        "prePreTxData": [hex::encode(&mint_proof)]
    }));
    assert_eq!(wrapper_direct, vec![direct.to_hex()]);

    let receivers = (0..6).map(|_| FtReceiver { address: owner.address(), amount_raw: 100 }).collect();
    let distribution = ft.batch_transfer(
        owner.clone(), receivers, vec![mint_utxo], utxo(&distribution_fee_parent, &owner),
        vec![minted.mint.clone()], vec![mint_proof],
    ).expect("pinned batch builder must create realistic merge holdings")
        .into_iter().map(|entry| Transaction::from_hex(&entry.txraw).expect("valid builder tx")).collect::<Vec<_>>();
    assert_eq!(distribution.len(), 2, "six receivers require two pinned batches");
    let wrapper_distribution = wrapper_ft_transactions(json!({
        "operation": "batchTransfer",
        "privateKeyWif": wrapper_key,
        "asset": ft_info_json(&ft),
        "receivers": (0..6).map(|_| json!({
            "address": owner.address().to_string(), "amountRaw": "100"
        })).collect::<Vec<_>>(),
        "assetUtxos": [ft_utxo_json(&FtUtxo {
            base: Utxo {
                outpoint: OutPoint { txid: minted.mint.txid(), vout: 0 },
                satoshis: minted.mint.outputs[0].satoshis,
                script_pubkey: minted.mint.outputs[0].script_pubkey.clone(),
                private_key: owner.clone(),
            },
            ft_balance_raw: 600,
        })],
        "feeUtxo": fee_utxo_json(&distribution_fee_parent),
        "preTxs": [minted.mint.to_hex()],
        "prePreTxData": [hex::encode(pre_pre_tx_data_from_parents(
            &minted.mint, 0, &[minted.source.clone()]
        ).expect("mint ancestry must remain encodable"))]
    }));
    assert_eq!(wrapper_distribution, distribution.iter().map(Transaction::to_hex).collect::<Vec<_>>());

    let first = &distribution[0];
    let second = &distribution[1];
    let mut merge_utxos = Vec::new();
    let mut merge_parents = Vec::new();
    let mut merge_proofs = Vec::new();
    for output_index in [0u32, 2, 4, 6, 8] {
        merge_utxos.push(FtUtxo {
            base: Utxo {
                outpoint: OutPoint { txid: first.txid(), vout: output_index },
                satoshis: FT_CODE_SATOSHIS,
                script_pubkey: first.outputs[output_index as usize].script_pubkey.clone(),
                private_key: owner.clone(),
            },
            ft_balance_raw: 100,
        });
        merge_parents.push(first.clone());
        merge_proofs.push(pre_pre_tx_data_from_parents(first, output_index as usize, &[minted.mint.clone()])
            .expect("first batch ancestry must be encodable"));
    }
    merge_utxos.push(FtUtxo {
        base: Utxo {
            outpoint: OutPoint { txid: second.txid(), vout: 0 },
            satoshis: FT_CODE_SATOSHIS,
            script_pubkey: second.outputs[0].script_pubkey.clone(),
            private_key: owner.clone(),
        },
        ft_balance_raw: 100,
    });
    merge_parents.push(second.clone());
    merge_proofs.push(pre_pre_tx_data_from_parents(second, 0, &[first.clone()])
        .expect("second batch ancestry must be encodable"));
    let transfer_chain_merge_request = json!({
        "kind": "ft",
        "privateKeyWif": wrapper_key,
        "asset": ft_info_json(&ft),
        "assetUtxos": merge_utxos[..5].iter().map(ft_utxo_json).collect::<Vec<_>>(),
        "feeUtxo": fee_utxo_json(&transfer_chain_fee_parent),
        "preTxs": merge_parents[..5].iter().map(Transaction::to_hex).collect::<Vec<_>>(),
        "prePreTxData": merge_proofs[..5].iter().map(hex::encode).collect::<Vec<_>>()
    });
    let transfer_chain_merge: Value = serde_json::from_str(
        &build_merge_batch_json(&transfer_chain_merge_request.to_string())
            .expect("pinned threshold-five merge wrapper must execute"),
    ).expect("pinned threshold-five merge wrapper must return JSON");
    let transfer_chain_merge_raw = transfer_chain_merge.as_array()
        .expect("threshold-five merge wrapper array")
        .first().expect("threshold-five merge transaction")["txraw"]
        .as_str().expect("threshold-five merge txraw");
    let wallet_transfer_chain_maintenance = Transaction::from_hex(transfer_chain_merge_raw)
        .expect("threshold-five merge raw must parse");
    let wallet_merged_utxo = FtUtxo {
        base: Utxo {
            outpoint: OutPoint { txid: wallet_transfer_chain_maintenance.txid(), vout: 0 },
            satoshis: wallet_transfer_chain_maintenance.outputs[0].satoshis,
            script_pubkey: wallet_transfer_chain_maintenance.outputs[0].script_pubkey.clone(),
            private_key: owner.clone(),
        },
        ft_balance_raw: 500,
    };
    let wallet_transfer_fee = Utxo {
        outpoint: OutPoint { txid: wallet_transfer_chain_maintenance.txid(), vout: 2 },
        satoshis: wallet_transfer_chain_maintenance.outputs[2].satoshis,
        script_pubkey: wallet_transfer_chain_maintenance.outputs[2].script_pubkey.clone(),
        private_key: owner.clone(),
    };
    let wallet_merged_proof = pre_pre_tx_data_from_parents(
        &wallet_transfer_chain_maintenance,
        0,
        &vec![first.clone(); 5],
    ).expect("threshold-five merge ancestry must be encodable");
    let wallet_transfer_chain_transfer = wrapper_ft_transactions(json!({
        "operation": "transfer",
        "privateKeyWif": wrapper_key,
        "asset": ft_info_json(&ft),
        "recipient": recipient.address().to_string(),
        "amountRaw": "600",
        "assetUtxos": [ft_utxo_json(&wallet_merged_utxo), ft_utxo_json(&merge_utxos[5])],
        "feeUtxo": {
            "txid": wallet_transfer_fee.outpoint.txid.to_string(),
            "outputIndex": wallet_transfer_fee.outpoint.vout,
            "satoshis": wallet_transfer_fee.satoshis,
            "script": hex::encode(wallet_transfer_fee.script_pubkey.as_bytes())
        },
        "preTxs": [wallet_transfer_chain_maintenance.to_hex(), second.to_hex()],
        "prePreTxData": [hex::encode(&wallet_merged_proof), hex::encode(&merge_proofs[5])]
    }));
    assert_eq!(wallet_transfer_chain_transfer.len(), 1);
    let wallet_transfer_chain_primary = Transaction::from_hex(&wallet_transfer_chain_transfer[0])
        .expect("threshold-five transfer raw must parse");
    let wallet_high_level_transfer = wrapper_ft_transactions(json!({
        "operation": "transfer",
        "privateKeyWif": wrapper_key,
        "asset": ft_info_json(&ft),
        "recipient": recipient.address().to_string(),
        "amountRaw": "600",
        "assetUtxos": [ft_utxo_json(&merge_utxos[5]), ft_utxo_json(&wallet_merged_utxo)],
        "feeUtxo": {
            "txid": wallet_transfer_fee.outpoint.txid.to_string(),
            "outputIndex": wallet_transfer_fee.outpoint.vout,
            "satoshis": wallet_transfer_fee.satoshis,
            "script": hex::encode(wallet_transfer_fee.script_pubkey.as_bytes())
        },
        "preTxs": [second.to_hex(), wallet_transfer_chain_maintenance.to_hex()],
        "prePreTxData": [hex::encode(&merge_proofs[5]), hex::encode(&wallet_merged_proof)]
    }));
    assert_eq!(wallet_high_level_transfer.len(), 1);
    let wallet_high_level_primary = Transaction::from_hex(&wallet_high_level_transfer[0])
        .expect("public selector-ordered transfer raw must parse");
    let mut sdk_maintenance_nodes = ft.merge_ft(
        owner.clone(),
        merge_utxos[..5].to_vec(),
        utxo(&transfer_chain_fee_parent, &owner),
        merge_parents[..5].to_vec(),
        merge_proofs[..5].to_vec(),
    ).expect("pinned SDK threshold-five merge must execute");
    assert_eq!(sdk_maintenance_nodes.len(), 1);
    let transfer_chain_maintenance = sdk_maintenance_nodes.remove(0);
    let sdk_merged_utxo = FtUtxo {
        base: Utxo {
            outpoint: OutPoint { txid: transfer_chain_maintenance.txid(), vout: 0 },
            satoshis: transfer_chain_maintenance.outputs[0].satoshis,
            script_pubkey: transfer_chain_maintenance.outputs[0].script_pubkey.clone(),
            private_key: owner.clone(),
        },
        ft_balance_raw: 500,
    };
    let sdk_transfer_fee = Utxo {
        outpoint: OutPoint { txid: transfer_chain_maintenance.txid(), vout: 2 },
        satoshis: transfer_chain_maintenance.outputs[2].satoshis,
        script_pubkey: transfer_chain_maintenance.outputs[2].script_pubkey.clone(),
        private_key: owner.clone(),
    };
    let sdk_merged_proof = pre_pre_tx_data_from_parents(
        &transfer_chain_maintenance,
        0,
        &vec![first.clone(); 5],
    ).expect("pinned SDK threshold-five ancestry must be encodable");
    let transfer_chain_primary = ft.transfer(
        owner.clone(),
        recipient.address(),
        600,
        vec![sdk_merged_utxo, merge_utxos[5].clone()],
        sdk_transfer_fee,
        vec![transfer_chain_maintenance.clone(), second.clone()],
        vec![sdk_merged_proof, merge_proofs[5].clone()],
        None,
    ).expect("pinned SDK transfer after threshold-five maintenance must execute");
    let wallet_orchestration_inputs = json!({
        "key": wrapper_key,
        "contract": ft_info_json(&ft),
        "sources": merge_utxos.iter().zip(merge_parents.iter()).zip(merge_proofs.iter()).map(
            |((utxo, parent), proof)| json!({
                "utxo": ft_utxo_json(utxo),
                "preTxRaw": parent.to_hex(),
                "prePreTxData": hex::encode(proof),
            })
        ).collect::<Vec<_>>(),
        "feeUtxos": [fee_utxo_json(&transfer_chain_fee_parent)],
        "amount": "600",
    });
    let wrapper_merge_request = json!({
        "kind": "ft",
        "privateKeyWif": wrapper_key,
        "asset": ft_info_json(&ft),
        "assetUtxos": merge_utxos.iter().map(ft_utxo_json).collect::<Vec<_>>(),
        "feeUtxo": fee_utxo_json(&merge_fee_parent),
        "preTxs": merge_parents.iter().map(Transaction::to_hex).collect::<Vec<_>>(),
        "prePreTxData": merge_proofs.iter().map(hex::encode).collect::<Vec<_>>()
    });
    let merged = ft.merge_ft(
        owner.clone(), merge_utxos, utxo(&merge_fee_parent, &owner), merge_parents, merge_proofs,
    ).expect("pinned terminal merge builder must execute");
    assert_eq!(merged.len(), 2, "six inputs require two terminal merge stages");
    let wrapper_merge: Value = serde_json::from_str(
        &build_merge_batch_json(&wrapper_merge_request.to_string())
            .expect("pinned merge wrapper must execute"),
    ).expect("pinned merge wrapper must return JSON");
    assert_eq!(
        wrapper_merge.as_array().expect("merge wrapper array").iter()
            .map(|entry| entry["txraw"].as_str().expect("merge wrapper txraw").to_owned())
            .collect::<Vec<_>>(),
        merged.iter().map(Transaction::to_hex).collect::<Vec<_>>()
    );

    let mut previous = PreviousOutputs::new();
    for parent in [
        &mint_funding_parent,
        &direct_fee_parent,
        &distribution_fee_parent,
        &merge_fee_parent,
        &transfer_chain_fee_parent,
    ] {
        register(parent, &mut previous);
    }
    let source_json = transaction_json(&minted.source, &previous);
    register(&minted.source, &mut previous);
    let mint_json = transaction_json(&minted.mint, &previous);
    register(&minted.mint, &mut previous);
    let direct_json = transaction_json(&direct, &previous);
    register(&direct, &mut previous);
    let distribution_json = distribution.iter().map(|tx| {
        let value = transaction_json(tx, &previous);
        register(tx, &mut previous);
        value
    }).collect::<Vec<_>>();
    let transfer_chain_json = [&transfer_chain_maintenance, &transfer_chain_primary]
        .into_iter().map(|tx| {
            let value = transaction_json(tx, &previous);
            register(tx, &mut previous);
            value
        }).collect::<Vec<_>>();
    let wallet_transfer_chain_json = [
        &wallet_transfer_chain_maintenance,
        &wallet_transfer_chain_primary,
    ].into_iter().map(|tx| {
        let value = transaction_json(tx, &previous);
        register(tx, &mut previous);
        value
    }).collect::<Vec<_>>();
    let wallet_high_level_transfer_chain_json = [
        &wallet_transfer_chain_maintenance,
        &wallet_high_level_primary,
    ].into_iter().map(|tx| transaction_json(tx, &previous)).collect::<Vec<_>>();
    let sdk_maintenance_fee = transfer_chain_json[0]["fee"].as_str().unwrap().parse::<u64>().unwrap();
    let wallet_maintenance_fee = wallet_transfer_chain_json[0]["fee"].as_str().unwrap().parse::<u64>().unwrap();
    assert_eq!(wallet_maintenance_fee, sdk_maintenance_fee + 2);
    let merge_json = merged.iter().map(|tx| {
        let value = transaction_json(tx, &previous);
        register(tx, &mut previous);
        value
    }).collect::<Vec<_>>();
    let holdings = [(first, 0u32), (first, 2), (first, 4), (first, 6), (first, 8), (second, 0)]
        .into_iter().map(|(tx, vout)| json!({
            "txid": tx.txid().to_string(),
            "vout": vout,
            "satoshis": tx.outputs[vout as usize].satoshis.to_string(),
            "scriptPubKey": hex::encode(tx.outputs[vout as usize].script_pubkey.as_bytes()),
            "balance": "100"
        })).collect::<Vec<_>>();

    println!("{}", serde_json::to_string_pretty(&json!({
        "pin": PIN,
        "wrapperExecuted": {
            "mint": true, "transfer": true, "batchTransfer": true,
            "transferPreMaintenance": true, "merge": true
        },
        "owner": { "address": owner.address().to_string(), "publicKey": hex::encode(owner.public_key().to_bytes()) },
        "recipient": recipient.address().to_string(),
        "token": {
            "name": ft.name, "symbol": ft.symbol, "decimals": ft.decimal,
            "totalSupply": ft.total_supply_raw.to_string(), "contractId": ft.contract_txid,
            "codeScript": ft.code_script, "tapeScript": ft.tape_script
        },
        "funding": {
            "mint": parent_json(&mint_funding_parent), "direct": parent_json(&direct_fee_parent),
            "distribution": parent_json(&distribution_fee_parent), "merge": parent_json(&merge_fee_parent),
            "transferChain": parent_json(&transfer_chain_fee_parent)
        },
        "create": { "source": source_json, "mint": mint_json },
        "direct": direct_json,
        "distribution": distribution_json,
        "holdings": holdings,
        "walletOrchestrationInputs": wallet_orchestration_inputs,
        "transferChain": transfer_chain_json,
        "walletTransferChain": wallet_transfer_chain_json,
        "walletHighLevelTransferChain": wallet_high_level_transfer_chain_json,
        "transferChainRuling": {
            "selected": "sdk-protocol-valid",
            "walletMaintenanceFeeDelta": "2"
        },
        "explicitMerge": merge_json,
        "parents": [parent_json(&minted.source), parent_json(&minted.mint), parent_json(first), parent_json(second)]
    })).expect("comparator JSON must serialize"));
}
