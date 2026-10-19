use serde::{Deserialize, Serialize};
use tbc_engine_core::protocols::{coin, tbc20, tbc721};
use tbc_sdk::{
    InMemoryTokenTransactionFetcher, TokenValidationOptions, Transaction,
    contracts::nft::{NftData, scripts as nft_scripts},
    script::Script,
    validate_on_chain_transaction_with_fetcher,
};

const RECEIVER_BYTES: usize = 21;
const CODE_SUFFIX: &[u8] = b"\x052Code";

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct TokenReceiptRequest {
    raw_transaction: String,
    #[serde(default)]
    contract_code_script: Option<String>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct TokenReceiptOutput {
    code_vout: usize,
    tape_vout: usize,
    family: String,
    version: u8,
    #[serde(skip_serializing_if = "Option::is_none")]
    standard_id: Option<&'static str>,
    balance_raw: String,
    controller: String,
    contract_code_matches: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    lock_time: Option<u32>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct TokenReceiptResponse {
    txid: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    contract_standard_id: Option<&'static str>,
    outputs: Vec<TokenReceiptOutput>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct NftReceiptRequest {
    raw_transaction: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct NftReceiptOutput {
    code_vout: usize,
    hold_vout: usize,
    tape_vout: usize,
    version: u8,
    #[serde(skip_serializing_if = "Option::is_none")]
    standard_id: Option<&'static str>,
    collection_id: String,
    token_id: String,
    controller: String,
    hold_script: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct NftReceiptResponse {
    txid: String,
    outputs: Vec<NftReceiptOutput>,
}

fn receiver_range(code: &[u8]) -> Result<std::ops::Range<usize>, String> {
    if !code.ends_with(CODE_SUFFIX) {
        return Err("token Code marker is missing".to_owned());
    }
    let push = code
        .len()
        .checked_sub(CODE_SUFFIX.len() + RECEIVER_BYTES + 1)
        .ok_or_else(|| "token Code receiver is truncated".to_owned())?;
    if code[push] != RECEIVER_BYTES as u8 {
        return Err("token Code receiver is not a direct 21-byte push".to_owned());
    }
    Ok(push + 1..push + 1 + RECEIVER_BYTES)
}

fn same_contract_code(actual: &[u8], expected: Option<&[u8]>) -> Result<bool, String> {
    let Some(expected) = expected else {
        return Ok(false);
    };
    if actual.len() != expected.len() {
        return Ok(false);
    }
    let actual_receiver = receiver_range(actual)?;
    let expected_receiver = receiver_range(expected)?;
    if actual_receiver != expected_receiver {
        return Ok(false);
    }
    Ok(actual
        .iter()
        .zip(expected)
        .enumerate()
        .all(|(index, (left, right))| actual_receiver.contains(&index) || left == right))
}

pub fn inspect_token_receipt_json(request_json: &str) -> Result<String, String> {
    let request: TokenReceiptRequest = serde_json::from_str(request_json)
        .map_err(|error| format!("invalid token receipt request: {error}"))?;
    let transaction = Transaction::from_hex(&request.raw_transaction)
        .map_err(|error| format!("rawTransaction: {error}"))?;
    let expected_code = request
        .contract_code_script
        .as_deref()
        .map(hex::decode)
        .transpose()
        .map_err(|_| "contractCodeScript must be canonical hex".to_owned())?;
    let empty = InMemoryTokenTransactionFetcher::default();
    let report = validate_on_chain_transaction_with_fetcher(TokenValidationOptions {
        transaction: Some(transaction.clone()),
        network: "testnet".to_owned(),
        fetcher: Some(&empty),
        ..TokenValidationOptions::default()
    });
    if report.issues.iter().any(|issue| {
        issue.stage == "OUTPUT_SCAN"
            && matches!(issue.code.as_str(), "INVALID_TBC20_CODE" | "INVALID_TOKEN_TAPE")
    }) {
        return Err("transaction contains an invalid token output".to_owned());
    }
    let mut outputs = Vec::new();
    // Recognition/receipt inspection only: callers supply the trusted expected
    // Code, while node acceptance and ancestry remain separate evidence layers.
    // The shared codec authenticates the full new template and derives identity
    // including asset origin, excluding only the controller tail.
    let expected_tbc20_identity = expected_code.as_deref()
        .and_then(|code| tbc20::code_identity(code).ok());
    let expected_coin_identity = expected_code.as_deref()
        .and_then(|code| coin::code_identity(code).ok());
    // Preserve the published family grouping while sharing exact pair semantics
    // with generic Reviewed material inspection, not a second copied decoder.
    let mut current_coin = Vec::new();
    let mut current_ft = Vec::new();
    for (code_vout, output) in transaction.outputs.iter().enumerate() {
        let code = output.script_pubkey.as_bytes();
        let Some(descriptor) = super::token_material::inspect_code(code) else { continue; };
        let standard = descriptor.standard_id;
        let tape_vout = code_vout + 1;
        let tape = transaction.outputs.get(tape_vout)
            .ok_or_else(|| format!("{standard} Tape output is missing"))?;
        let pair = super::token_material::complete_pair(descriptor, output.satoshis,
            tape.script_pubkey.as_bytes(), tape.satoshis)?;
        let expected = if standard == "tbc20-stablecoin" { &expected_coin_identity } else { &expected_tbc20_identity };
        let target = if standard == "tbc20-stablecoin" { &mut current_coin } else { &mut current_ft };
        target.push(TokenReceiptOutput {
            code_vout, tape_vout, family: if standard == "tbc20-stablecoin" { "COIN" } else { "TBC20" }.to_owned(),
            version: 1, standard_id: Some(pair.code.standard_id), balance_raw: pair.balance_raw,
            controller: pair.code.controller,
            contract_code_matches: expected.as_ref().is_some_and(|identity| hex::encode(identity) == pair.code.code_identity),
            lock_time: pair.lock_time,
        });
    }
    outputs.extend(current_coin);
    outputs.extend(current_ft);
    // The historical ancestry validator deliberately scans FT only. Use its
    // pure pair decoder for StableCoin receipts, without enabling issuance
    // classification or fetching parents.
    for (code_vout, output) in transaction.outputs.iter().enumerate() {
        let pair = tbc_sdk::validator::inspect_published_token_pair(
            output, transaction.outputs.get(code_vout + 1))
            .map_err(|error| format!("historical token pair: {error}"))?;
        let Some(pair) = pair.filter(|pair| pair.protocol.family == "STABLE_COIN") else { continue; };
        let tape_vout = code_vout + 1;
        let code = output.script_pubkey.as_bytes();
        let range = receiver_range(code)?;
        let lock_time = tbc_sdk::contracts::stable_coin::scripts::get_lock_time_from_tape(
            &transaction.outputs[tape_vout].script_pubkey).map_err(|error| error.to_string())?;
        outputs.push(TokenReceiptOutput {
            code_vout, tape_vout, family: pair.protocol.family, version: pair.protocol.version,
            standard_id: None, balance_raw: pair.balance.to_string(),
            controller: hex::encode(&code[range]),
            contract_code_matches: same_contract_code(code, expected_code.as_deref())?,
            lock_time: Some(lock_time),
        });
    }
    for group in report.output_groups {
        let Some(protocol) = group.protocol else {
            continue;
        };
        if !matches!(protocol.family.as_str(), "FT" | "TBC20") {
            continue;
        }
        let (Some(code_vout), Some(tape_vout), Some(balance_raw)) =
            (group.code_vout, group.tape_vout, group.balance_raw)
        else {
            return Err("validated token output evidence is incomplete".to_owned());
        };
        let code = transaction
            .outputs
            .get(code_vout)
            .ok_or_else(|| "validated token Code output is missing".to_owned())?
            .script_pubkey
            .as_bytes();
        let range = receiver_range(code)?;
        outputs.push(TokenReceiptOutput {
            code_vout,
            tape_vout,
            family: protocol.family,
            version: protocol.version,
            standard_id: None,
            balance_raw,
            controller: hex::encode(&code[range]),
            contract_code_matches: same_contract_code(code, expected_code.as_deref())?,
            lock_time: None,
        });
    }
    outputs.sort_by_key(|output| output.code_vout);
    serde_json::to_string(&TokenReceiptResponse {
        txid: transaction.txid().to_string(),
        contract_standard_id: expected_tbc20_identity.as_ref().map(|_| "tbc20-standard")
            .or_else(|| expected_coin_identity.as_ref().map(|_| "tbc20-stablecoin")),
        outputs,
    })
    .map_err(|error| error.to_string())
}

fn nft_origin(script: &Script, version: nft_scripts::NftVersion) -> Result<(String, u32), String> {
    let bytes = script.as_bytes();
    for start in 0..bytes.len().saturating_sub(36) {
        if bytes[start] != 0x24 || start + 37 > bytes.len() {
            continue;
        }
        let mut txid = bytes[start + 1..start + 33].to_vec();
        txid.reverse();
        let id = hex::encode(txid);
        let vout = u32::from_le_bytes(bytes[start + 33..start + 37].try_into().unwrap());
        let candidate = match version {
            nft_scripts::NftVersion::V1 => nft_scripts::code_script_v1(&id, vout),
            nft_scripts::NftVersion::V2 => nft_scripts::code_script(&id, vout),
            nft_scripts::NftVersion::V0 => continue,
        };
        if candidate.as_ref().is_ok_and(|candidate| candidate == script) {
            return Ok((id, vout));
        }
    }
    Err("NFT code origin binding is invalid or legacy v0".to_owned())
}

fn nft_hold_controller(script: &Script) -> Result<String, String> {
    let bytes = script.as_bytes();
    const PREFIX: &[u8] = b"\x76\xa9\x14";
    const SUFFIX: &[u8] = b"\x88\xac\x6a\x0dV0 Curr NHold";
    if bytes.len() != PREFIX.len() + 20 + SUFFIX.len()
        || !bytes.starts_with(PREFIX)
        || !bytes.ends_with(SUFFIX)
    {
        return Err("NFT hold output is not canonical".to_owned());
    }
    Ok(format!("{}00", hex::encode(&bytes[PREFIX.len()..PREFIX.len() + 20])))
}

fn validate_nft_tape(script: &Script) -> Result<(), String> {
    let bytes = script.as_bytes();
    if !bytes.starts_with(&[0, 0x6a]) || !bytes.ends_with(b"\x05NTape") {
        return Err("NFT Tape framing is invalid".to_owned());
    }
    let mut offset = 2usize;
    let opcode = *bytes.get(offset).ok_or_else(|| "NFT Tape JSON push is missing".to_owned())?;
    offset += 1;
    let length = match opcode {
        0..=75 => opcode as usize,
        0x4c => {
            let value = *bytes.get(offset).ok_or_else(|| "NFT Tape JSON push is truncated".to_owned())?;
            offset += 1;
            value as usize
        }
        0x4d => {
            let raw: [u8; 2] = bytes.get(offset..offset + 2)
                .ok_or_else(|| "NFT Tape JSON push is truncated".to_owned())?
                .try_into().unwrap();
            offset += 2;
            u16::from_le_bytes(raw) as usize
        }
        _ => return Err("NFT Tape JSON push width is unsupported".to_owned()),
    };
    let end = offset.checked_add(length).ok_or_else(|| "NFT Tape JSON length overflow".to_owned())?;
    let json = bytes.get(offset..end).ok_or_else(|| "NFT Tape JSON is truncated".to_owned())?;
    let _: NftData = serde_json::from_slice(json).map_err(|_| "NFT Tape JSON is invalid".to_owned())?;
    if end + 6 != bytes.len() || bytes[end] != 5 || &bytes[end + 1..] != b"NTape" {
        return Err("NFT Tape marker is invalid".to_owned());
    }
    Ok(())
}

pub fn inspect_nft_receipt_json(request_json: &str) -> Result<String, String> {
    let request: NftReceiptRequest = serde_json::from_str(request_json)
        .map_err(|error| format!("invalid NFT receipt request: {error}"))?;
    let transaction = Transaction::from_hex(&request.raw_transaction)
        .map_err(|error| format!("rawTransaction: {error}"))?;
    let mut outputs = Vec::new();
    for (code_vout, code) in transaction.outputs.iter().enumerate() {
        let (version, standard_id, collection_id, token_id) = if let Ok(new_code) =
            tbc721::parse_code(code.script_pubkey.as_bytes()) {
            (3, Some(tbc721::STANDARD_ID), new_code.original_outpoint.txid.to_string(), new_code.original_outpoint.vout)
        } else if let Some(old_version) = nft_scripts::nft_version(&code.script_pubkey) {
            let (id, index) = nft_origin(&code.script_pubkey, old_version)?;
            let number = match old_version {
                nft_scripts::NftVersion::V0 => 0,
                nft_scripts::NftVersion::V1 => 1,
                nft_scripts::NftVersion::V2 => 2,
            };
            (number, None, id, index)
        } else {
            continue;
        };
        let hold_vout = code_vout + 1;
        let tape_vout = code_vout + 2;
        let hold = transaction.outputs.get(hold_vout)
            .ok_or_else(|| "NFT hold output is missing".to_owned())?;
        let tape = transaction.outputs.get(tape_vout)
            .ok_or_else(|| "NFT Tape output is missing".to_owned())?;
        if code.satoshis != nft_scripts::NFT_CODE_SATOSHIS
            || hold.satoshis != nft_scripts::NFT_HOLD_SATOSHIS
            || tape.satoshis != nft_scripts::NFT_TAPE_SATOSHIS
        {
            return Err("NFT output values are not canonical".to_owned());
        }
        let controller = nft_hold_controller(&hold.script_pubkey)?;
        validate_nft_tape(&tape.script_pubkey)?;
        outputs.push(NftReceiptOutput {
            code_vout,
            hold_vout,
            tape_vout,
            version,
            standard_id,
            collection_id,
            token_id: token_id.to_string(),
            controller,
            hold_script: hex::encode(hold.script_pubkey.as_bytes()),
        });
    }
    serde_json::to_string(&NftReceiptResponse {
        txid: transaction.txid().to_string(),
        outputs,
    })
    .map_err(|error| error.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;
    use tbc_sdk::{Address, OutPoint, TxIn, TxOut, Txid, contracts::ft::scripts};

    fn new_tbc20_fixture() -> serde_json::Value {
        serde_json::from_str(include_str!("../../../fixtures/tbc20-standard-transfer.json")).unwrap()
    }

    fn inspect(transaction: &Transaction, expected: Option<&[u8]>) -> Result<serde_json::Value, String> {
        inspect_token_receipt_json(&serde_json::json!({
            "rawTransaction": transaction.to_hex(), "contractCodeScript": expected.map(hex::encode),
        }).to_string()).map(|text| serde_json::from_str(&text).unwrap())
    }

    #[test]
    fn coin_receipt_binds_full_identity_and_reports_locks_without_claiming_maturity() {
        let fixture:serde_json::Value=serde_json::from_str(include_str!("../../../fixtures/coin-proof.json")).unwrap();
        let parent=Transaction::from_hex(fixture["vectors"][0]["parentRaw"].as_str().unwrap()).unwrap();
        let expected=parent.outputs[3].script_pubkey.as_bytes();
        for (index,count) in [(0,2),(1,1),(3,1)] {
            let tx=Transaction::from_hex(fixture["vectors"][index]["signedRaw"].as_str().unwrap()).unwrap();
            let receipt=inspect(&tx,Some(expected)).unwrap();
            assert_eq!(receipt["contractStandardId"],"tbc20-stablecoin");
            let outputs=receipt["outputs"].as_array().unwrap();assert_eq!(outputs.len(),count);
            assert_eq!(outputs.iter().map(|o|o["balanceRaw"].as_str().unwrap().parse::<u128>().unwrap()).sum::<u128>(),1000);
            for output in outputs {assert_eq!(output["standardId"],"tbc20-stablecoin");
                assert_eq!(output["contractCodeMatches"],true);assert_eq!(output["lockTime"],0);}
        }
        let mut locked=parent.clone();
        locked.outputs[4].script_pubkey=Script::from_bytes(coin::set_lock_time(locked.outputs[4].script_pubkey.as_bytes(),u32::MAX).unwrap());
        let receipt=inspect(&locked,Some(expected)).unwrap();
        assert_eq!(receipt["outputs"][0]["lockTime"],u32::MAX);
        assert_eq!(receipt["outputs"][0]["contractCodeMatches"],true);
        for field in 0..2 {
            let mut bad=coin::parse_code(expected).unwrap();
            if field==0 {bad.coin_nft_code_hash[0]^=1;}else{bad.admin_pubkey_hash[0]^=1;}
            assert_eq!(inspect(&parent,Some(&coin::instantiate_code(&bad).unwrap())).unwrap()["outputs"][0]["contractCodeMatches"],false);
        }
        let mut moved=parent.clone();let mut code=coin::parse_code(expected).unwrap();code.controller[0]^=1;
        moved.outputs[3].script_pubkey=Script::from_bytes(coin::instantiate_code(&code).unwrap());
        assert_eq!(inspect(&moved,Some(expected)).unwrap()["outputs"][0]["contractCodeMatches"],true);
    }

    #[test]
    fn coin_receipt_rejects_malformed_pairs_and_sums_slots_without_overflow() {
        let fixture:serde_json::Value=serde_json::from_str(include_str!("../../../fixtures/coin-proof.json")).unwrap();
        let tx=Transaction::from_hex(fixture["vectors"][0]["parentRaw"].as_str().unwrap()).unwrap();
        let mut large=tx.clone();
        large.outputs[4].script_pubkey=Script::from_bytes(coin::replace_tape_amounts(large.outputs[4].script_pubkey.as_bytes(),[tbc20::MAX_SLOT_AMOUNT;6]).unwrap());
        assert_eq!(inspect(&large,None).unwrap()["outputs"][0]["balanceRaw"],(6u128*u128::from(tbc20::MAX_SLOT_AMOUNT)).to_string());
        for case in 0..5 {
            let mut bad=tx.clone();
            match case {0=>bad.outputs.truncate(4),1=>bad.outputs[3].satoshis=501,2=>bad.outputs[4].satoshis=1,
                _=>{let mut tape=bad.outputs[4].script_pubkey.as_bytes().to_vec();
                    if case==3 {let n=tape.len();tape[n-15]=3;}else{tape[10]|=0x80;}
                    bad.outputs[4].script_pubkey=Script::from_bytes(tape);}}
            assert!(inspect(&bad,None).is_err(),"case {case}");
        }
    }

    #[test]
    fn historical_stablecoin_receipt_remains_distinct_from_new_coin() {
        use tbc_sdk::contracts::stable_coin::scripts as old;
        let fixture:serde_json::Value=serde_json::from_str(include_str!("../../../fixtures/coin-proof.json")).unwrap();
        let mut tx=Transaction::from_hex(fixture["vectors"][0]["signedRaw"].as_str().unwrap()).unwrap();
        let new_code=tx.outputs[0].script_pubkey.as_bytes().to_vec();
        let mut amounts=[0;48];amounts[..8].copy_from_slice(&25u64.to_le_bytes());
        let tape=old::coin_tape_script(&amounts,6,"Old Coin","OLD",100);
        let owner=Address::from_string("1BgGZ9tcN4rm9KBzDn7KprQz87SZ26SAMH").unwrap();
        for version in [old::StableCoinMintVersion::V3,old::StableCoinMintVersion::V4] {
            let code=old::coin_mint_code_script_with_version(&[7;20],&owner,&[8;32],tape.as_bytes().len(),version).unwrap();
            tx.outputs=vec![TxOut{satoshis:500,script_pubkey:code.clone()},TxOut{satoshis:0,script_pubkey:tape.clone()}];
            let receipt=inspect(&tx,Some(code.as_bytes())).unwrap();
            assert_eq!(receipt["outputs"][0]["family"],"STABLE_COIN");
            assert_eq!(receipt["outputs"][0]["contractCodeMatches"],true);
            assert_eq!(receipt["outputs"][0]["balanceRaw"],"25");assert_eq!(receipt["outputs"][0]["lockTime"],100);
            assert!(receipt.get("contractStandardId").is_none());
            assert_eq!(inspect(&tx,Some(&new_code)).unwrap()["outputs"][0]["contractCodeMatches"],false);
            tx.outputs[1].satoshis=1;
            assert!(inspect(&tx,Some(code.as_bytes())).is_err());
        }
    }

    #[test]
    fn new_tbc20_receipt_reads_frozen_genesis_transfer_merge() {
        let fixture = new_tbc20_fixture();
        let genesis = Transaction::from_hex(fixture["stages"][1]["signedRaw"].as_str().unwrap()).unwrap();
        for (index, amounts) in [(1, vec!["123456"]), (2, vec!["40000", "83456"]), (3, vec!["123456"])] {
            let tx = Transaction::from_hex(fixture["stages"][index]["signedRaw"].as_str().unwrap()).unwrap();
            let receipt = inspect(&tx, Some(genesis.outputs[0].script_pubkey.as_bytes())).unwrap();
            let outputs = receipt["outputs"].as_array().unwrap();
            assert_eq!(outputs.len(), amounts.len());
            for (group, amount) in outputs.iter().zip(amounts) {
                assert_eq!(group["standardId"], "tbc20-standard");
                assert_eq!(group["family"], "TBC20");
                assert_eq!(group["balanceRaw"], amount);
                assert_eq!(group["controller"].as_str().unwrap().len(), 42);
                assert_eq!(group["contractCodeMatches"], true);
            }
            assert_eq!(receipt["txid"], fixture["stages"][index]["txid"]);
            assert_eq!(receipt["contractStandardId"], "tbc20-standard");
        }
    }

    #[test]
    fn new_tbc20_receipt_identity_ignores_owner_not_origin_and_reports_expected_profile() {
        let fixture = new_tbc20_fixture();
        let mut tx = Transaction::from_hex(fixture["stages"][1]["signedRaw"].as_str().unwrap()).unwrap();
        let expected = tx.outputs[0].script_pubkey.as_bytes().to_vec();
        let mut receiver = [0x33; 21]; receiver[20] = 0;
        tx.outputs[0].script_pubkey = Script::from_bytes(tbc20::replace_controller(&expected, receiver).unwrap());
        let receipt = inspect(&tx, Some(&expected)).unwrap();
        assert_eq!(receipt["outputs"][0]["contractCodeMatches"], true);
        assert_eq!(receipt["outputs"][0]["controller"], hex::encode(receiver));
        let mut wrong_origin = tbc20::parse_code(&expected).unwrap();
        wrong_origin.original_outpoint[0] ^= 1;
        let wrong_expected = tbc20::instantiate_code(&wrong_origin).unwrap();
        let receipt = inspect(&tx, Some(&wrong_expected)).unwrap();
        assert_eq!(receipt["outputs"][0]["contractCodeMatches"], false);
        assert_eq!(receipt["contractStandardId"], "tbc20-standard");
        let unknown = inspect(&tx, None).unwrap();
        assert_eq!(unknown["outputs"][0]["contractCodeMatches"], false);
        assert!(unknown.get("contractStandardId").is_none());
        // Metadata profile comes from the trusted expected Code, independently
        // of whether this particular transaction pays any of that asset.
        tx.outputs.drain(..2);
        let empty = inspect(&tx, Some(&expected)).unwrap();
        assert_eq!(empty["outputs"].as_array().unwrap().len(), 0);
        assert_eq!(empty["contractStandardId"], "tbc20-standard");
    }

    #[test]
    fn new_tbc20_receipt_sums_all_slots_in_u128_and_rejects_bad_pair_material() {
        let fixture = new_tbc20_fixture();
        let tx = Transaction::from_hex(fixture["stages"][1]["signedRaw"].as_str().unwrap()).unwrap();
        let tape = tbc20::parse_tape(tx.outputs[1].script_pubkey.as_bytes()).unwrap();
        let mut large = tx.clone();
        large.outputs[1].script_pubkey = Script::from_bytes(tbc20::build_tape([tbc20::MAX_SLOT_AMOUNT; 6], &tape.extension).unwrap());
        assert_eq!(inspect(&large, None).unwrap()["outputs"][0]["balanceRaw"], (u128::from(tbc20::MAX_SLOT_AMOUNT) * 6).to_string());
        for mutation in 0..7 {
            let mut bad = tx.clone();
            match mutation {
                0 => bad.outputs.truncate(1),
                1 => bad.outputs[0].satoshis = 501,
                2 => bad.outputs[1].satoshis = 1,
                3 => {
                    let mut descriptor = tbc20::parse_code(bad.outputs[0].script_pubkey.as_bytes()).unwrap();
                    descriptor.tape_size += 1;
                    bad.outputs[0].script_pubkey = Script::from_bytes(tbc20::instantiate_code(&descriptor).unwrap());
                }
                _ => {
                    let mut malformed = bad.outputs[1].script_pubkey.as_bytes().to_vec();
                    if mutation == 4 { let last = malformed.len() - 1; malformed[last] ^= 1; }
                    else if mutation == 5 { malformed[10] |= 0x80; } // First uint64 slot exceeds signed-63 cap.
                    else { malformed[2] = 0x4c; } // Wrong six-slot framing.
                    bad.outputs[1].script_pubkey = Script::from_bytes(malformed);
                }
            }
            assert!(inspect(&bad, None).is_err(), "mutation {mutation}");
        }
    }

    #[test]
    fn old_tbc20_receipt_keeps_old_profile_and_does_not_match_new_template() {
        use tbc_sdk::contracts::tbc20 as old;
        let fixture = new_tbc20_fixture();
        let mut tx = Transaction::from_hex(fixture["stages"][1]["signedRaw"].as_str().unwrap()).unwrap();
        let new_code = tx.outputs[0].script_pubkey.as_bytes().to_vec();
        let descriptor = tbc20::parse_code(&new_code).unwrap();
        let original = old::Tbc20Outpoint { txid: Txid::from_le_bytes([7; 32]), output_index: 0 };
        let old_code = old::instantiate_tbc20_code(&original, descriptor.controller, 61).unwrap();
        tx.outputs[0].script_pubkey = old_code.clone();
        tx.outputs[1].script_pubkey = old::build_tbc20_tape([25, 0, 0, 0, 0, 0], 61, &[9]).unwrap();
        let receipt = inspect(&tx, Some(old_code.as_bytes())).unwrap();
        assert_eq!(receipt["outputs"][0]["balanceRaw"], "25");
        assert_eq!(receipt["outputs"][0]["contractCodeMatches"], true);
        assert!(receipt.get("contractStandardId").is_none());
        assert!(receipt["outputs"][0].get("standardId").is_none());
        assert_eq!(inspect(&tx, Some(&new_code)).unwrap()["outputs"][0]["contractCodeMatches"], false);
    }

    #[test]
    fn contract_comparison_ignores_only_the_receiver() {
        let source = Txid::from_le_bytes([7; 32]);
        let owner = Address::from_string("1FMZk84eVEJ1QHas3Gke1U9ZPMKrPk36ex").unwrap();
        let receiver = Address::from_string("1BgGZ9tcN4rm9KBzDn7KprQz87SZ26SAMH").unwrap();
        let tape = scripts::mint_tape_script(&{
            let mut amount = [0u8; 48];
            amount[..8].copy_from_slice(&25u64.to_le_bytes());
            amount
        }, 0, "Token", "TOK");
        let base = scripts::mint_code_script(&source.to_string(), 0, &owner, tape.as_bytes().len()).unwrap();
        let code = scripts::transfer_code_script(
            &base,
            scripts::FtCodeReceiver::Address(receiver),
        )
        .unwrap();
        let transaction = Transaction {
            version: 10,
            inputs: vec![TxIn::new(OutPoint { txid: source, vout: 0 })],
            outputs: vec![
                TxOut { satoshis: 500, script_pubkey: code },
                TxOut { satoshis: 0, script_pubkey: tape },
            ],
            lock_time: 0,
        };
        let response: serde_json::Value = serde_json::from_str(
            &inspect_token_receipt_json(&serde_json::json!({
                "rawTransaction": transaction.to_hex(),
                "contractCodeScript": hex::encode(base.as_bytes()),
            }).to_string()).unwrap(),
        ).unwrap();
        assert_eq!(response["outputs"][0]["balanceRaw"], "25");
        assert_eq!(response["outputs"][0]["contractCodeMatches"], true);
        assert!(response["outputs"][0].get("standardId").is_none());
        assert!(response.get("contractStandardId").is_none());
    }

    #[test]
    fn nft_receipt_preserves_unique_collection_slot_and_owner() {
        let source = Txid::from_le_bytes([8; 32]);
        let receiver = Address::from_string("1BgGZ9tcN4rm9KBzDn7KprQz87SZ26SAMH").unwrap();
        let data = tbc_sdk::NftData {
            nft_name: "Receipt NFT".to_owned(),
            symbol: "RNFT".to_owned(),
            description: "receipt fixture".to_owned(),
            attributes: "[]".to_owned(),
            file: None,
        };
        let transaction = Transaction {
            version: 10,
            inputs: vec![TxIn::new(OutPoint { txid: source, vout: 7 })],
            outputs: vec![
                TxOut { satoshis: nft_scripts::NFT_CODE_SATOSHIS, script_pubkey: nft_scripts::code_script(&source.to_string(), 7).unwrap() },
                TxOut { satoshis: nft_scripts::NFT_HOLD_SATOSHIS, script_pubkey: nft_scripts::hold_script(&receiver) },
                TxOut { satoshis: nft_scripts::NFT_TAPE_SATOSHIS, script_pubkey: nft_scripts::tape_script(&data).unwrap() },
            ],
            lock_time: 0,
        };
        let response: serde_json::Value = serde_json::from_str(
            &inspect_nft_receipt_json(&serde_json::json!({
                "rawTransaction": transaction.to_hex(),
            }).to_string()).unwrap(),
        ).unwrap();
        assert_eq!(response["outputs"][0]["collectionId"], source.to_string());
        assert_eq!(response["outputs"][0]["tokenId"], "7");
        assert_eq!(response["outputs"][0]["version"], 2);
        assert!(response["outputs"][0].get("standardId").is_none());
    }

    #[test]
    fn new_tbc721_receipt_uses_full_code_identity_and_shared_hold_tape_rules() {
        let f: serde_json::Value = serde_json::from_str(include_str!(
            "../../../fixtures/tbc721-standard-proof.json")).unwrap();
        for vector in f["vectors"].as_array().unwrap() {
            let tx = Transaction::from_hex(vector["signedRaw"].as_str().unwrap()).unwrap();
            let descriptor = tbc721::parse_code(tx.outputs[0].script_pubkey.as_bytes()).unwrap();
            let inspect = |tx: &Transaction| inspect_nft_receipt_json(&serde_json::json!({
                "rawTransaction": tx.to_hex(),
            }).to_string());
            let response: serde_json::Value = serde_json::from_str(&inspect(&tx).unwrap()).unwrap();
            assert_eq!(response["outputs"].as_array().unwrap().len(), 1);
            assert_eq!(response["outputs"][0]["standardId"], "tbc721-standard");
            assert_eq!(response["outputs"][0]["version"], 3);
            assert_eq!(response["outputs"][0]["collectionId"], descriptor.original_outpoint.txid.to_string());
            assert_eq!(response["outputs"][0]["tokenId"], "3");
            let mut wrong = tx.clone(); wrong.outputs[1].satoshis += 1;
            assert!(inspect(&wrong).is_err());
            let mut wrong = tx.clone();
            let mut bytes = wrong.outputs[0].script_pubkey.as_bytes().to_vec(); bytes[0] ^= 1;
            wrong.outputs[0].script_pubkey = Script::from_bytes(bytes);
            let response: serde_json::Value = serde_json::from_str(&inspect(&wrong).unwrap()).unwrap();
            assert!(response["outputs"].as_array().unwrap().is_empty());
        }
    }
}
