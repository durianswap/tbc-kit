use std::{collections::BTreeMap, io::Read};

use serde_json::{Value, json};
use tbc_sdk::{
    FtReceiver, FtUtxo, Nft, OutPoint, PrivateKey, StableCoin, Transaction, TxIn,
    TxOut, Txid, Utxo,
    contracts::{
        ft::unlock::pre_pre_tx_data_from_parents,
        nft::{CollectionData, NftData, scripts::NftVersion},
    },
    script::Script,
    sighash::forkid_sighash,
};
use tbc_transaction_engine::{build_merge_batch_json, build_stablecoin_transaction_json, dispatch_json};

const PIN: &str = "923497e8b2473c0e179fa0b86dbb32a2f188d25a";
const LEGACY_CODE_PREFIX: &str = "OP_1 OP_PICK OP_3 OP_SPLIT 0x01 0x14 OP_SPLIT OP_DROP OP_TOALTSTACK OP_DROP OP_TOALTSTACK OP_SHA256 OP_CAT OP_FROMALTSTACK OP_CAT OP_1 OP_PICK OP_TOALTSTACK OP_TOALTSTACK OP_SHA256 OP_CAT OP_FROMALTSTACK OP_CAT OP_SHA256 OP_CAT OP_1 OP_PICK 0x01 0x24 OP_SPLIT OP_DROP OP_TOALTSTACK OP_TOALTSTACK OP_SHA256 OP_CAT OP_FROMALTSTACK OP_CAT OP_SHA256 OP_SHA256 OP_6 OP_PUSH_META 0x01 0x20 OP_SPLIT OP_DROP OP_EQUALVERIFY OP_1 OP_PICK OP_TOALTSTACK OP_TOALTSTACK OP_SHA256 OP_CAT OP_FROMALTSTACK OP_CAT OP_SHA256 OP_CAT OP_CAT OP_CAT OP_SHA256 OP_SHA256 OP_FROMALTSTACK OP_FROMALTSTACK OP_DUP 0x01 0x20 OP_SPLIT OP_DROP OP_3 OP_ROLL OP_EQUALVERIFY OP_SWAP OP_FROMALTSTACK OP_DUP OP_TOALTSTACK OP_EQUAL OP_IF OP_DROP OP_ELSE 0x24";
const LEGACY_CODE_SUFFIX: &str = "OP_EQUALVERIFY OP_ENDIF OP_1 OP_PICK OP_FROMALTSTACK OP_EQUALVERIFY OP_TOALTSTACK OP_SHA256 OP_CAT OP_FROMALTSTACK OP_CAT OP_SHA256 OP_7 OP_PUSH_META OP_EQUALVERIFY OP_DUP OP_HASH160 OP_FROMALTSTACK OP_EQUALVERIFY OP_CHECKSIG OP_RETURN 0x05 0x33436f6465";

fn legacy_code_script(txid: Txid, vout: u32) -> Script {
    let origin = format!("{}{}", hex::encode(txid.as_le_bytes()), hex::encode(vout.to_le_bytes()));
    Script::from_asm(&format!("{LEGACY_CODE_PREFIX} 0x{origin} {LEGACY_CODE_SUFFIX}")).unwrap()
}

fn key(last_byte: u8) -> PrivateKey {
    let mut bytes = [0u8; 32];
    bytes[31] = last_byte;
    PrivateKey::from_slice(&bytes).expect("input scalar")
}

fn parent(marker: u8, satoshis: u64, owner: &PrivateKey) -> Transaction {
    Transaction {
        version: tbc_sdk::TX_VERSION,
        inputs: vec![TxIn { previous_output: OutPoint { txid: Txid::from_le_bytes([marker; 32]), vout: marker as u32 }, script_sig: Script::from_bytes(vec![0x51, marker]), sequence: tbc_sdk::DEFAULT_SEQUENCE }],
        outputs: vec![TxOut { satoshis, script_pubkey: owner.address().script_pubkey() }],
        lock_time: marker as u32,
    }
}

fn utxo(tx: &Transaction, owner: &PrivateKey, vout: u32) -> Utxo {
    let output = &tx.outputs[vout as usize];
    Utxo { outpoint: OutPoint { txid: tx.txid(), vout }, satoshis: output.satoshis, script_pubkey: output.script_pubkey.clone(), private_key: owner.clone() }
}

fn dto(utxo: &Utxo) -> Value {
    json!({"txid":utxo.outpoint.txid.to_string(),"outputIndex":utxo.outpoint.vout,"satoshis":utxo.satoshis,"script":hex::encode(utxo.script_pubkey.as_bytes())})
}

fn asset_dto(utxo: &FtUtxo) -> Value {
    json!({"txid":utxo.base.outpoint.txid.to_string(),"outputIndex":utxo.base.outpoint.vout,"satoshis":utxo.base.satoshis,"script":hex::encode(utxo.base.script_pubkey.as_bytes()),"ftBalanceRaw":utxo.ft_balance_raw.to_string()})
}

fn core_utxo(tx: &Transaction, vout: u32, classification: &str, contract_id: Option<&str>) -> Value {
    let output = &tx.outputs[vout as usize];
    let mut value = json!({"txid":tx.txid().to_string(),"vout":vout,"satoshis":output.satoshis.to_string(),"scriptPubKey":hex::encode(output.script_pubkey.as_bytes()),"confirmations":"100","classification":classification});
    if let Some(contract_id) = contract_id { value["contractId"] = json!(contract_id); }
    value
}

fn core_parent(tx: &Transaction) -> Value {
    json!({"txid":tx.txid().to_string(),"rawTransaction":tx.to_hex()})
}

fn core_case(intent: Value, native: &Transaction, mut utxos: Vec<Value>, mut parents: Vec<Value>, contracts: Vec<Value>) -> Value {
    let mut value: Value = serde_json::from_str(include_str!("../core-base.json")).unwrap();
    let mut value = value["planInput"].take();
    value["request"]["intent"] = intent;
    value["request"]["constraints"]["maxFee"] = json!("50000");
    value["policy"]["payload"]["amountLimits"] = json!([]);
    utxos.insert(0, core_utxo(native, 0, "native", None));
    parents.insert(0, core_parent(native));
    value["snapshot"]["payload"]["utxos"] = Value::Array(utxos);
    value["snapshot"]["payload"]["parents"] = Value::Array(parents);
    value["snapshot"]["payload"]["contracts"] = Value::Array(contracts);
    value
}

fn raws(response: &str) -> Vec<String> {
    let value: Value = serde_json::from_str(response).expect("wrapper JSON");
    value["transactions"].as_array().expect("transactions").iter().map(|item| item["txraw"].as_str().expect("txraw").to_owned()).collect()
}

fn nft_wrapper(request: Value) -> Vec<String> {
    raws(&dispatch_json("buildNft", &request.to_string()).expect("pinned NFT wrapper"))
}

fn pushed(bytes: &[u8], offset: usize) -> Option<(&[u8], usize)> {
    let opcode = *bytes.get(offset)?;
    let (header, length) = match opcode {
        0..=75 => (1, opcode as usize),
        76 => (2, *bytes.get(offset + 1)? as usize),
        _ => return None,
    };
    let start = offset.checked_add(header)?;
    let end = start.checked_add(length)?;
    Some((bytes.get(start..end)?, end))
}

fn source_signing_recipes(raws: &[String], parents: &[Transaction]) -> Value {
    let mut prevouts = BTreeMap::new();
    for parent in parents {
        for (vout, output) in parent.outputs.iter().enumerate() {
            prevouts.insert((parent.txid().to_string(), vout as u32), output.clone());
        }
    }
    let mut prior = BTreeMap::<String, (usize, usize)>::new();
    let mut evidence = Vec::new();
    for (transaction_index, raw) in raws.iter().enumerate() {
        let transaction = Transaction::from_hex(raw).expect("pinned signing transaction");
        let transaction_association = transaction.txid().to_string();
        let mut actual_dependencies = Vec::new();
        let mut stage = 0usize;
        let mut signers = Vec::new();
        for (input_index, input) in transaction.inputs.iter().enumerate() {
            let parent_txid = input.previous_output.txid.to_string();
            if let Some((parent_index, parent_stage)) = prior.get(&parent_txid) {
                stage = stage.max(parent_stage + 1);
                actual_dependencies.push(json!({
                    "parentTransactionAssociation": parent_txid,
                    "parentTransactionIndex": parent_index,
                    "childInputIndex": input_index,
                    "parentVout": input.previous_output.vout,
                }));
            }
            let previous = prevouts.get(&(parent_txid.clone(), input.previous_output.vout)).expect("pinned signer prevout");
            let bytes = input.script_sig.as_bytes();
            let (signature, signature_end) = pushed(bytes, 0).expect("pinned signature push");
            let (public_key, public_key_end) = pushed(bytes, signature_end).expect("pinned public-key push");
            let sighash_type = *signature.last().expect("pinned sighash byte") as u32;
            let covenant_suffix = hex::encode(&bytes[public_key_end..]);
            let digest = forkid_sighash(
                &transaction,
                input_index,
                &previous.script_pubkey,
                previous.satoshis,
                sighash_type,
            ).expect("pinned ForkID digest");
            signers.push(json!({
                "transactionAssociation": transaction_association,
                "inputIndex": input_index,
                "digest": hex::encode(digest),
                "publicKey": hex::encode(public_key),
                "sighashType": sighash_type,
                "signerRole": if covenant_suffix.is_empty() { "funding" } else { "covenant" },
                "covenantSuffix": covenant_suffix,
                "previousOutpoint": {"txid": parent_txid, "vout": input.previous_output.vout},
                "previousSatoshis": previous.satoshis.to_string(),
                "previousScript": hex::encode(previous.script_pubkey.as_bytes()),
            }));
        }
        for (vout, output) in transaction.outputs.iter().enumerate() {
            prevouts.insert((transaction_association.clone(), vout as u32), output.clone());
        }
        prior.insert(transaction_association.clone(), (transaction_index, stage));
        evidence.push(json!({
            "transactionAssociation": transaction_association,
            "stage": stage,
            "signers": signers,
            "actualDependencies": actual_dependencies,
        }));
    }
    Value::Array(evidence)
}

fn main() {
    let mut input = String::new();
    std::io::stdin().read_to_string(&mut input).expect("read inputs");
    let input: Value = serde_json::from_str(&input).expect("input JSON");
    let owner = key(input["ownerScalar"].as_u64().expect("ownerScalar") as u8);
    let recipient = key(input["recipientScalar"].as_u64().expect("recipientScalar") as u8);
    let admin = key(input["adminScalar"].as_u64().expect("adminScalar") as u8);
    let collection_media = json!({"kind":"uri","uri":"ipfs://task6","mediaType":"image/png","sha256":"11".repeat(32)});
    let nft_media = json!({"kind":"uri","uri":"ipfs://task6/1","mediaType":"image/png","sha256":"22".repeat(32)});
    let collection_data = CollectionData { collection_name: "Comparator Collection".to_owned(), description: "Pinned source comparator".to_owned(), supply: 2, file: serde_json::to_string(&collection_media).unwrap() };
    let nft_data = NftData { nft_name: "Comparator NFT".to_owned(), symbol: "CNFT".to_owned(), description: "Pinned source comparator".to_owned(), attributes: "[{\"traitType\":\"rarity\",\"value\":\"source\"}]".to_owned(), file: Some(serde_json::to_string(&nft_media).unwrap()) };
    let collection_fee = parent(0x11, 1_000_000, &owner);
    let mint_fee = parent(0x12, 1_000_000, &owner);
    let transfer_fee = parent(0x13, 1_000_000, &owner);
    let collection = Nft::create_collection(owner.address(), owner.clone(), collection_data.clone(), vec![utxo(&collection_fee, &owner, 0)]).expect("SDK collection");
    let wallet_collection = nft_wrapper(json!({"operation":"createCollection","privateKeyWif":owner.to_wif(),"address":owner.address().to_string(),"data":collection_data,"funding":dto(&utxo(&collection_fee,&owner,0))}));
    let minted = Nft::create_nft(collection.txid().to_string(), owner.address(), owner.clone(), nft_data.clone(), vec![utxo(&mint_fee,&owner,0)], utxo(&collection,&owner,1)).expect("SDK mint");
    let wallet_mint = nft_wrapper(json!({"operation":"mint","privateKeyWif":owner.to_wif(),"collectionId":collection.txid().to_string(),"address":owner.address().to_string(),"data":nft_data.clone(),"funding":dto(&utxo(&mint_fee,&owner,0)),"mintSlot":dto(&utxo(&collection,&owner,1))}));
    let nft = Nft::new(collection.txid().to_string(), 1).with_data(nft_data.clone());
    let transferred = nft.transfer_nft(owner.address(), recipient.address(), owner.clone(), vec![utxo(&transfer_fee,&owner,0)], minted.clone(), collection.clone(), false).expect("SDK transfer");
    let wallet_transfer = nft_wrapper(json!({"operation":"transfer","privateKeyWif":owner.to_wif(),"addressFrom":owner.address().to_string(),"funding":dto(&utxo(&transfer_fee,&owner,0)),"item":{"recipient":recipient.address().to_string(),"collectionId":collection.txid().to_string(),"collectionIndex":1,"data":nft.nft_data,"preTx":minted.to_hex(),"prePreTx":collection.to_hex(),"version":2}}));
    let minted_v1 = Nft::create_nft_with_version(collection.txid().to_string(), owner.address(), owner.clone(), nft_data.clone(), vec![utxo(&mint_fee,&owner,0)], utxo(&collection,&owner,2), NftVersion::V1).expect("SDK V1 mint");
    let nft_v1 = Nft::new(collection.txid().to_string(), 2).with_data(nft_data.clone());
    let transferred_v1 = nft_v1.transfer_nft(owner.address(), recipient.address(), owner.clone(), vec![utxo(&transfer_fee,&owner,0)], minted_v1.clone(), collection.clone(), false).expect("SDK V1 transfer");
    let wallet_v1 = nft_wrapper(json!({"operation":"transfer","privateKeyWif":owner.to_wif(),"addressFrom":owner.address().to_string(),"funding":dto(&utxo(&transfer_fee,&owner,0)),"item":{"recipient":recipient.address().to_string(),"collectionId":collection.txid().to_string(),"collectionIndex":2,"data":nft_v1.nft_data,"preTx":minted_v1.to_hex(),"prePreTx":collection.to_hex(),"version":1}}));
    let mut legacy_minted = minted.clone();
    legacy_minted.outputs[0].script_pubkey = legacy_code_script(collection.txid(), 1);
    let wallet_v0 = nft_wrapper(json!({"operation":"transfer","privateKeyWif":owner.to_wif(),"addressFrom":owner.address().to_string(),"funding":dto(&utxo(&transfer_fee,&owner,0)),"item":{"recipient":recipient.address().to_string(),"collectionId":collection.txid().to_string(),"collectionIndex":1,"data":nft.nft_data,"preTx":legacy_minted.to_hex(),"prePreTx":collection.to_hex(),"version":0}}));
    let wallet_v0_changed = nft_wrapper(json!({"operation":"transfer","privateKeyWif":owner.to_wif(),"addressFrom":owner.address().to_string(),"funding":dto(&utxo(&transfer_fee,&owner,0)),"item":{"recipient":admin.address().to_string(),"collectionId":collection.txid().to_string(),"collectionIndex":1,"data":nft.nft_data,"preTx":legacy_minted.to_hex(),"prePreTx":collection.to_hex(),"version":0}}));

    let root = parent(0x20, 2_000_000, &owner);
    let coin_fee = Transaction {
        version: tbc_sdk::TX_VERSION,
        inputs: vec![TxIn::new(OutPoint { txid: root.txid(), vout: 0 })],
        outputs: vec![TxOut { satoshis: 1_000_000, script_pubkey: owner.address().script_pubkey() }],
        lock_time: 0,
    };
    let mut coin = StableCoin::new("Comparator Dollar".to_owned(), "CDR".to_owned(), 600, 0).expect("coin");
    let prepared = coin.create_coin(admin.x_only_public_key(), owner.clone(), owner.address(), utxo(&coin_fee,&owner,0), root.clone(), None).expect("coin create");
    let created = prepared.finalize_with_admin_key(&admin).expect("coin finalize");
    coin.contract_txid = created.contract_txid.clone();
    let genesis = FtUtxo { base: utxo(&created.mint,&owner,3), ft_balance_raw: 600 };
    let genesis_proof = pre_pre_tx_data_from_parents(&created.mint, 3, &[created.coin_nft.clone()]).expect("coin proof");
    let stable_fee = parent(0x22, 2_000_000, &owner);
    let stable = coin.transfer(owner.clone(), recipient.address(), 200, vec![genesis.clone()], utxo(&stable_fee,&owner,0), vec![created.mint.clone()], vec![genesis_proof.clone()], Some(24)).expect("SDK stable transfer");
    let coin_info = json!({"name":coin.name,"symbol":coin.symbol,"decimal":coin.decimal,"totalSupplyRaw":coin.total_supply_raw.to_string(),"contractTxid":coin.contract_txid,"codeScript":coin.code_script,"tapeScript":coin.tape_script});
    let wallet_stable = raws(&build_stablecoin_transaction_json(&json!({"operation":"transfer","privateKeyWif":owner.to_wif(),"asset":coin_info,"recipient":recipient.address().to_string(),"amountRaw":"200","tbcAmountSat":24,"assetUtxos":[asset_dto(&genesis)],"feeUtxo":dto(&utxo(&stable_fee,&owner,0)),"preTxs":[created.mint.to_hex()],"prePreTxData":[hex::encode(&genesis_proof)]}).to_string()).expect("stable wrapper"));
    let changed = raws(&build_stablecoin_transaction_json(&json!({"operation":"transfer","privateKeyWif":owner.to_wif(),"asset":coin_info,"recipient":recipient.address().to_string(),"amountRaw":"199","tbcAmountSat":24,"assetUtxos":[asset_dto(&genesis)],"feeUtxo":dto(&utxo(&stable_fee,&owner,0)),"preTxs":[created.mint.to_hex()],"prePreTxData":[hex::encode(&genesis_proof)]}).to_string()).expect("stable mutation"));

    let batch_fee = parent(0x23, 3_000_000, &owner);
    let distributed = coin.batch_transfer(owner.clone(), (0..6).map(|_| FtReceiver { address: owner.address(), amount_raw: 100 }).collect(), vec![genesis], utxo(&batch_fee,&owner,0), vec![created.mint.clone()], vec![genesis_proof]).expect("stable distribution").into_iter().map(|item| Transaction::from_hex(&item.txraw).unwrap()).collect::<Vec<_>>();
    let mut holdings = Vec::new(); let mut pre_txs = Vec::new(); let mut proofs = Vec::new();
    for vout in [0u32,2,4,6,8] { holdings.push(FtUtxo { base: utxo(&distributed[0],&owner,vout), ft_balance_raw:100 }); pre_txs.push(distributed[0].clone()); proofs.push(pre_pre_tx_data_from_parents(&distributed[0],vout as usize,&[created.mint.clone()]).unwrap()); }
    holdings.push(FtUtxo { base: utxo(&distributed[1],&owner,0), ft_balance_raw:100 }); pre_txs.push(distributed[1].clone()); proofs.push(pre_pre_tx_data_from_parents(&distributed[1],0,&[distributed[0].clone()]).unwrap());
    let merge_fee = parent(0x24, 4_000_000, &owner);
    let sdk_merge = coin.merge_coin(owner.clone(), holdings.clone(), utxo(&merge_fee,&owner,0), pre_txs.clone(), proofs.clone()).expect("SDK stable merge").into_iter().map(|tx| tx.to_hex()).collect::<Vec<_>>();
    let wallet_merge: Value = serde_json::from_str(&build_merge_batch_json(&json!({"kind":"stablecoin","privateKeyWif":owner.to_wif(),"asset":coin_info,"assetUtxos":holdings.iter().map(asset_dto).collect::<Vec<_>>(),"feeUtxo":dto(&utxo(&merge_fee,&owner,0)),"preTxs":pre_txs.iter().map(Transaction::to_hex).collect::<Vec<_>>(),"prePreTxData":proofs.iter().map(hex::encode).collect::<Vec<_>>()}).to_string()).expect("merge wrapper")).unwrap();
    let wallet_merge = wallet_merge.as_array().unwrap().iter().map(|item| item["txraw"].as_str().unwrap().to_owned()).collect::<Vec<_>>();
    let changed_collection = Nft::create_collection(owner.address(), owner.clone(), CollectionData { collection_name:"Comparator Collection Mutated".to_owned(), ..collection_data.clone() }, vec![utxo(&collection_fee,&owner,0)]).unwrap();
    let changed_nft = nft.transfer_nft(owner.address(), admin.address(), owner.clone(), vec![utxo(&transfer_fee,&owner,0)], minted.clone(), collection.clone(), false).unwrap();
    let collection_id = collection.txid().to_string();
    let stable_id = created.mint.txid().to_string();
    let core_inputs = json!({
        "collection": core_case(json!({"type":"tbc.collection.create","version":"1.0","name":"Comparator Collection","description":"Pinned source comparator","supply":"2","media":collection_media}), &collection_fee, vec![], vec![], vec![]),
        "nftMint": core_case(json!({"type":"tbc.nft.mint","version":"1.0","collectionId":collection_id,"name":"Comparator NFT","symbol":"CNFT","description":"Pinned source comparator","attributes":[{"traitType":"rarity","value":"source"}],"media":nft_media}), &mint_fee, vec![core_utxo(&collection,1,"collection-slot",Some(&collection_id))], vec![core_parent(&collection)], vec![json!({"contractId":collection_id,"family":"collection","protocolVersion":"2.0","creationTxid":collection_id,"currentOutpoint":{"txid":collection_id,"vout":1}})]),
        "nftTransfer": core_case(json!({"type":"tbc.nft.transfer","version":"1.0","contractId":minted.txid().to_string(),"to":recipient.address().to_string()}), &transfer_fee, vec![core_utxo(&minted,0,"nft",Some(&minted.txid().to_string())),core_utxo(&minted,1,"nft",Some(&minted.txid().to_string()))], vec![core_parent(&collection),core_parent(&minted)], vec![json!({"contractId":minted.txid().to_string(),"family":"nft","protocolVersion":"2.0","creationTxid":minted.txid().to_string(),"currentOutpoint":{"txid":minted.txid().to_string(),"vout":0}})]),
        "nftTransferV1": core_case(json!({"type":"tbc.nft.transfer","version":"1.0","contractId":minted_v1.txid().to_string(),"to":recipient.address().to_string()}), &transfer_fee, vec![core_utxo(&minted_v1,0,"nft",Some(&minted_v1.txid().to_string())),core_utxo(&minted_v1,1,"nft",Some(&minted_v1.txid().to_string()))], vec![core_parent(&collection),core_parent(&minted_v1)], vec![json!({"contractId":minted_v1.txid().to_string(),"family":"nft","protocolVersion":"2.0","creationTxid":minted_v1.txid().to_string(),"currentOutpoint":{"txid":minted_v1.txid().to_string(),"vout":0}})]),
        "nftTransferV0": core_case(json!({"type":"tbc.nft.transfer","version":"1.0","contractId":legacy_minted.txid().to_string(),"to":recipient.address().to_string()}), &transfer_fee, vec![core_utxo(&legacy_minted,0,"nft",Some(&legacy_minted.txid().to_string())),core_utxo(&legacy_minted,1,"nft",Some(&legacy_minted.txid().to_string()))], vec![core_parent(&collection),core_parent(&legacy_minted)], vec![json!({"contractId":legacy_minted.txid().to_string(),"family":"nft","protocolVersion":"2.0","creationTxid":legacy_minted.txid().to_string(),"currentOutpoint":{"txid":legacy_minted.txid().to_string(),"vout":0}})]),
        "stablecoinTransfer": core_case(json!({"type":"tbc.stablecoin.transfer","version":"1.0","contractId":stable_id,"to":recipient.address().to_string(),"amount":"200","attachedTbcAmount":"24"}), &stable_fee, vec![core_utxo(&created.mint,3,"stablecoin",Some(&stable_id))], vec![core_parent(&root),core_parent(&coin_fee),core_parent(&created.coin_nft),core_parent(&created.mint)], vec![json!({"contractId":stable_id,"family":"stablecoin","protocolVersion":"4.0","creationTxid":stable_id,"currentOutpoint":{"txid":created.mint.txid().to_string(),"vout":3}})]),
        "stablecoinMerge": core_case(json!({"type":"tbc.stablecoin.transfer","version":"1.0","contractId":stable_id,"to":recipient.address().to_string(),"amount":"550","attachedTbcAmount":"24"}), &merge_fee, holdings.iter().map(|item| core_utxo(pre_txs.iter().find(|tx| tx.txid()==item.base.outpoint.txid).unwrap(),item.base.outpoint.vout,"stablecoin",Some(&stable_id))).collect(), { let mut values=vec![core_parent(&root),core_parent(&coin_fee),core_parent(&created.coin_nft),core_parent(&created.mint)]; for tx in &distributed { if !values.iter().any(|item| item["txid"]==tx.txid().to_string()) { values.push(core_parent(tx)); } } values }, vec![json!({"contractId":stable_id,"family":"stablecoin","protocolVersion":"4.0","creationTxid":stable_id,"currentOutpoint":{"txid":holdings[0].base.outpoint.txid.to_string(),"vout":holdings[0].base.outpoint.vout}})])
    });
    let nft_recipe_parents = vec![collection_fee.clone(), mint_fee.clone(), transfer_fee.clone(), collection.clone(), minted.clone(), minted_v1.clone(), legacy_minted.clone()];
    let source_signing_recipes = json!({
        "collection": source_signing_recipes(&[collection.to_hex()], &nft_recipe_parents),
        "nftMint": source_signing_recipes(&[minted.to_hex()], &nft_recipe_parents),
        "nftTransferV2": source_signing_recipes(&[transferred.to_hex()], &nft_recipe_parents),
        "nftTransferV1": source_signing_recipes(&[transferred_v1.to_hex()], &nft_recipe_parents),
        "nftTransferV0": source_signing_recipes(&wallet_v0, &nft_recipe_parents),
        "nftTransferV0Mutation": source_signing_recipes(&wallet_v0_changed, &nft_recipe_parents),
    });
    println!("{}", json!({"pin":PIN,"operations":{"collection":{"sdk":[collection.to_hex()],"wallet":wallet_collection},"nftMint":{"sdk":[minted.to_hex()],"wallet":wallet_mint},"nftTransfer":{"sdk":[transferred.to_hex()],"wallet":wallet_transfer},"stablecoinTransfer":{"sdk":[stable.to_hex()],"wallet":wallet_stable},"stablecoinMerge":{"sdk":sdk_merge,"wallet":wallet_merge}},"sourceSigningRecipes":source_signing_recipes,"coreInputs":core_inputs,"vectors":{"nftV0":wallet_v0,"nftV1":{"sdk":[transferred_v1.to_hex()],"wallet":wallet_v1},"nftV2":[transferred.to_hex()]},"mutations":{"collection":{"baseline":collection.to_hex(),"changed":changed_collection.to_hex(),"path":["request","intent","name"],"value":"Comparator Collection Mutated"},"nft":{"baseline":transferred.to_hex(),"changed":changed_nft.to_hex(),"path":["request","intent","to"],"value":admin.address().to_string()},"nftV0Recipient":{"baseline":wallet_v0[0],"changed":wallet_v0_changed[0],"path":["request","intent","to"],"value":admin.address().to_string()},"stablecoin":{"baseline":stable.to_hex(),"changed":changed[0],"path":["request","intent","amount"],"value":"199"}}}));
}
