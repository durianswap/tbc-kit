use std::{collections::BTreeMap, io::Read};

use serde_json::{Value, json};
use secp256k1::{Message, Secp256k1, SecretKey};
use sha2::{Digest, Sha256};
use tbc_engine_core::call_json_name;
use tbc_sdk::{Transaction, script::Script, sighash::forkid_sighash};

fn hex(bytes: &[u8]) -> String {
    const DIGITS: &[u8; 16] = b"0123456789abcdef";
    let mut value = String::with_capacity(bytes.len() * 2);
    for byte in bytes { value.push(DIGITS[(byte >> 4) as usize] as char); value.push(DIGITS[(byte & 15) as usize] as char); }
    value
}

fn normalize(raw: &str) -> Value {
    let transaction = Transaction::from_hex(raw).expect("transaction");
    let inputs = transaction.inputs.iter().map(|input| json!({"txid":input.previous_output.txid.to_string(),"vout":input.previous_output.vout,"sequence":input.sequence})).collect::<Vec<_>>();
    let outputs = transaction.outputs.iter().map(|output| json!({"satoshis":output.satoshis.to_string(),"script":hex(output.script_pubkey.as_bytes())})).collect::<Vec<_>>();
    let signature_slots = transaction.inputs.iter().enumerate().map(|(index, input)| json!({"inputIndex":index,"occupied":!input.script_sig.as_bytes().is_empty()})).collect::<Vec<_>>();
    let mut unsigned = transaction.clone();
    for input in &mut unsigned.inputs { input.script_sig = Script::empty(); }
    let canonical_signature_neutral_raw = unsigned.to_hex();
    let signature_neutral_txid = unsigned.txid().to_string();
    let covenant_suffixes = transaction.inputs.iter().map(|input| json!(covenant_suffix(input.script_sig.as_bytes()))).collect::<Vec<_>>();
    json!({"version":transaction.version,"inputs":inputs,"outputs":outputs,"lockTime":transaction.lock_time,"unsignedRaw":canonical_signature_neutral_raw,"canonicalSignatureNeutralRaw":canonical_signature_neutral_raw,"signatureNeutralTxid":signature_neutral_txid,"signatureSlots":signature_slots,"signedRaw":raw,"txid":transaction.txid().to_string(),"covenantSuffixes":covenant_suffixes})
}

fn pushed_end(bytes: &[u8], offset: usize) -> Option<usize> {
    let opcode = *bytes.get(offset)?;
    let (header, length) = match opcode { 0..=75 => (1, opcode as usize), 76 => (2, *bytes.get(offset + 1)? as usize), _ => return None };
    offset.checked_add(header)?.checked_add(length).filter(|end| *end <= bytes.len())
}

fn covenant_suffix(bytes: &[u8]) -> String {
    let Some(first) = pushed_end(bytes, 0) else { return String::new() };
    let Some(second) = pushed_end(bytes, first) else { return String::new() };
    hex(&bytes[second..])
}

fn decode_hex(value: &str) -> Vec<u8> {
    value.as_bytes().chunks_exact(2).map(|pair| {
        let digit = |byte: u8| match byte { b'0'..=b'9' => byte - b'0', b'a'..=b'f' => byte - b'a' + 10, _ => panic!("hex") };
        digit(pair[0]) * 16 + digit(pair[1])
    }).collect()
}

fn signatures(tasks: &Value) -> Value {
    let mut scalar = [0u8; 32]; scalar[31] = 1;
    let secret = SecretKey::from_byte_array(scalar).unwrap();
    let secp = Secp256k1::new();
    Value::Array(tasks.as_array().unwrap().iter().map(|task| {
        let digest: [u8; 32] = decode_hex(task["digest"].as_str().unwrap()).try_into().unwrap();
        let signature = secp.sign_ecdsa(Message::from_digest(digest), &secret).serialize_compact();
        json!({"taskId":task["taskId"],"signatureEncoding":"compact64","signature":hex(&signature)})
    }).collect())
}

fn canonical_hash(value: &Value) -> String { hex(&Sha256::digest(serde_json::to_vec(value).unwrap())) }
fn call(method: &str, input: &Value) -> Value { serde_json::from_str(&call_json_name(method, &input.to_string())).expect("core result") }

fn bind(mut input: Value) -> Value {
    let normalized = call("normalizeRequest", &json!({"version":"1.0","request":input["request"]}));
    assert_eq!(normalized["ok"], true, "normalizeRequest failed: {normalized}");
    input["request"] = normalized["result"]["request"].clone();
    input["requestHash"] = normalized["result"]["requestHash"].clone();
    input["snapshot"]["snapshotHash"] = json!(canonical_hash(&input["snapshot"]["payload"]));
    input["policy"]["policyHash"] = json!(canonical_hash(&input["policy"]["payload"]));
    input
}

fn finalize_input(input: &Value, planned: &Value) -> Value {
    let payload = json!({
        "version":"1.0","method":"tbc_sendTransaction","operationKind":"transaction",
        "contextHash":"11".repeat(32),"origin":"https://task6.test","sessionId":"task6-comparator",
        "chainId":input["request"]["chainId"],
        "accountId":format!("{}:{}", input["request"]["chainId"].as_str().unwrap(), input["request"]["from"].as_str().unwrap()),
        "requestHash":input["requestHash"],"operationHash":planned["planHash"],"expiresAt":planned["payload"]["expiresAt"]
    });
    let binding_hash = canonical_hash(&payload);
    json!({
        "version":input["version"],"request":input["request"],"requestHash":input["requestHash"],"snapshot":input["snapshot"],"policy":input["policy"],"plan":planned,
        "binding":{"payload":payload,"bindingHash":binding_hash},
        "approval":{"status":"approved","approvalId":"task6-comparator","approvalToken":"external-test-signatures","bindingHash":binding_hash,"approvedAt":"2026-08-31T12:00:10Z","expiresAt":planned["payload"]["expiresAt"]},
        "signatures":signatures(&planned["payload"]["signingTasks"])
    })
}

fn set_path(value: &mut Value, path: &[Value], replacement: &Value) {
    let mut cursor = value;
    for key in &path[..path.len() - 1] { cursor = &mut cursor[key.as_str().unwrap()]; }
    cursor[path.last().unwrap().as_str().unwrap()] = replacement.clone();
}

fn source_matrix(raws: &[Value], core_input: &Value) -> Vec<Value> {
    let mut outputs = BTreeMap::new();
    for parent in core_input["snapshot"]["payload"]["parents"].as_array().expect("parents") {
        let tx = Transaction::from_hex(parent["rawTransaction"].as_str().expect("parent raw")).expect("parent transaction");
        for (vout, output) in tx.outputs.iter().enumerate() { outputs.insert((tx.txid().to_string(), vout as u32), output.satoshis); }
    }
    raws.iter().map(|raw| {
        let raw = raw.as_str().expect("raw transaction");
        let tx = Transaction::from_hex(raw).expect("source transaction");
        let input_sum = tx.inputs.iter().map(|input| outputs.get(&(input.previous_output.txid.to_string(), input.previous_output.vout)).copied().expect("source prevout value")).sum::<u64>();
        let output_sum = tx.outputs.iter().map(|output| output.satoshis).sum::<u64>();
        let mut value = normalize(raw);
        value["fee"] = json!((input_sum - output_sum).to_string());
        for (vout, output) in tx.outputs.iter().enumerate() { outputs.insert((tx.txid().to_string(), vout as u32), output.satoshis); }
        value
    }).collect()
}

fn recompute_signing_digests(raw: &str, tasks: &Value, core_input: &Value) -> Value {
    let transaction = Transaction::from_hex(raw).expect("core signing transaction");
    let mut prevouts = BTreeMap::new();
    for parent in core_input["snapshot"]["payload"]["parents"].as_array().expect("parents") {
        let parent = Transaction::from_hex(parent["rawTransaction"].as_str().expect("parent raw")).expect("parent transaction");
        for (vout, output) in parent.outputs.iter().enumerate() {
            prevouts.insert((parent.txid().to_string(), vout as u32), output.clone());
        }
    }
    Value::Array(tasks.as_array().expect("signing tasks").iter().map(|task| {
        let input_index = task["inputIndex"].as_u64().expect("input index") as usize;
        let input = &transaction.inputs[input_index];
        let previous = prevouts.get(&(input.previous_output.txid.to_string(), input.previous_output.vout)).expect("core signer prevout");
        let sighash_type = task["sighashType"].as_u64().expect("sighash type") as u32;
        let digest = forkid_sighash(&transaction, input_index, &previous.script_pubkey, previous.satoshis, sighash_type).expect("core ForkID digest");
        json!({"inputIndex":input_index,"digest":hex(&digest)})
    }).collect())
}

fn main() {
    let mut input = String::new();
    std::io::stdin().read_to_string(&mut input).expect("source result");
    let source: Value = serde_json::from_str(&input).expect("source JSON");
    let mut source_operations = serde_json::Map::new();
    for (name, result) in source["operations"].as_object().expect("source operations") {
        source_operations.insert(name.clone(), Value::Array(source_matrix(result["sdk"].as_array().expect("SDK transactions"), &source["coreInputs"][name])));
    }
    source_operations.insert("nftTransferV0".to_owned(), Value::Array(source_matrix(source["vectors"]["nftV0"].as_array().expect("V0 vector"), &source["coreInputs"]["nftTransferV0"])));
    source_operations.insert("nftTransferV1".to_owned(), Value::Array(source_matrix(source["vectors"]["nftV1"]["sdk"].as_array().expect("V1 vector"), &source["coreInputs"]["nftTransferV1"])));

    let mut operations = serde_json::Map::new();
    for (name, raw_input) in source["coreInputs"].as_object().expect("core inputs") {
        let input = bind(raw_input.clone());
        let planned = call("plan", &input);
        assert_eq!(planned["ok"], true, "{name} core plan failed: {planned}");
        let plan = &planned["result"]["plan"];
        let mut stage_tasks = vec![plan["payload"]["signingTasks"].clone()];
        let mut finalize = finalize_input(&input, plan);
        let first = call("finalize", &finalize);
        assert_eq!(first["ok"], true, "{name} core finalize failed: {first}");
        let complete = if first["result"]["status"] == "pending" {
            stage_tasks.push(first["result"]["signingRequests"].clone());
            finalize["continuation"] = first["result"]["continuation"].clone();
            finalize["signatures"] = signatures(&first["result"]["signingRequests"]);
            let second = call("finalize", &finalize);
            assert_eq!(second["ok"], true, "{name} second core finalize failed: {second}");
            second
        } else { first };
        let finalized = complete["result"]["bundle"]["transactions"].as_array().expect("complete bundle");
        let templates = planned["result"]["plan"]["payload"]["transactions"].as_array().expect("planned transactions");
        let matrix = templates.iter().enumerate().map(|(stage_index, template)| {
            let mut value = normalize(template["unsignedTransaction"].as_str().expect("unsigned transaction"));
            let finalized_transaction = normalize(finalized[stage_index]["rawTransaction"].as_str().expect("finalized raw"));
            value["finalizedRaw"] = finalized_transaction["signedRaw"].clone();
            value["finalizedTxid"] = finalized_transaction["txid"].clone();
            value["finalizedSignatureNeutralRaw"] = finalized_transaction["canonicalSignatureNeutralRaw"].clone();
            value["covenantSuffixes"] = finalized_transaction["covenantSuffixes"].clone();
            value["fee"] = template["fee"].clone();
            value["role"] = template["role"].clone();
            value["templateId"] = template["id"].clone();
            value["planDependencies"] = template["dependsOn"].clone();
            value["dependsOn"] = template["dependsOn"].clone();
            value["signingRequests"] = stage_tasks[stage_index].clone();
            if name == "collection" || name.starts_with("nft") {
                value["recomputedSigningDigests"] = recompute_signing_digests(
                    template["unsignedTransaction"].as_str().expect("unsigned transaction"),
                    &stage_tasks[stage_index],
                    &input,
                );
            }
            value
        }).collect::<Vec<_>>();
        let validation_input = json!({"version":input["version"],"phase":"plan","request":input["request"],"requestHash":input["requestHash"],"snapshot":input["snapshot"],"policy":input["policy"],"plan":planned["result"]["plan"]});
        let validated = call("validate", &validation_input);
        assert_eq!(validated["ok"], true, "{name} core validate failed: {validated}");
        assert_eq!(validated["result"]["valid"], true, "{name} core validate violations: {validated}");
        operations.insert(name.clone(), Value::Array(matrix));
    }
    let mut mutations = serde_json::Map::new();
    for (family, mutation) in source["mutations"].as_object().expect("mutations") {
        let operation = match family.as_str() { "collection" => "collection", "nft" => "nftTransfer", "nftV0Recipient" => "nftTransferV0", _ => "stablecoinTransfer" };
        let mut changed = source["coreInputs"][operation].clone();
        set_path(&mut changed, mutation["path"].as_array().unwrap(), &mutation["value"]);
        let changed = bind(changed);
        let planned = call("plan", &changed);
        assert_eq!(planned["ok"], true, "{family} mutated core plan failed: {planned}");
        let changed_raw = planned["result"]["plan"]["payload"]["transactions"][0]["unsignedTransaction"].as_str().unwrap();
        let baseline_raw = operations[operation][0]["unsignedRaw"].as_str().unwrap();
        let mut mutation_value = json!({"sourceChanged":mutation["baseline"] != mutation["changed"],"coreChanged":baseline_raw != changed_raw,"changedUnsignedRaw":changed_raw,"changedSigningRequests":planned["result"]["plan"]["payload"]["signingTasks"]});
        if family == "nftV0Recipient" {
            let plan = &planned["result"]["plan"];
            let finalized = call("finalize", &finalize_input(&changed, plan));
            assert_eq!(finalized["ok"], true, "V0 mutation finalize failed: {finalized}");
            let template = &plan["payload"]["transactions"][0];
            let finalized_raw = finalized["result"]["bundle"]["transactions"][0]["rawTransaction"].as_str().expect("V0 mutation finalized raw");
            let finalized_transaction = normalize(finalized_raw);
            let mut transaction = normalize(changed_raw);
            transaction["finalizedRaw"] = finalized_transaction["signedRaw"].clone();
            transaction["finalizedTxid"] = finalized_transaction["txid"].clone();
            transaction["finalizedSignatureNeutralRaw"] = finalized_transaction["canonicalSignatureNeutralRaw"].clone();
            transaction["covenantSuffixes"] = finalized_transaction["covenantSuffixes"].clone();
            transaction["fee"] = template["fee"].clone();
            transaction["role"] = template["role"].clone();
            transaction["templateId"] = template["id"].clone();
            transaction["planDependencies"] = template["dependsOn"].clone();
            transaction["dependsOn"] = template["dependsOn"].clone();
            transaction["signingRequests"] = plan["payload"]["signingTasks"].clone();
            transaction["recomputedSigningDigests"] = recompute_signing_digests(changed_raw, &plan["payload"]["signingTasks"], &changed);
            mutation_value["changedTransaction"] = transaction;
        }
        mutations.insert(family.clone(), mutation_value);
    }
    println!("{}", json!({"pin":source["pin"],"operations":operations,"sourceOperations":source_operations,"sourceSigningRecipes":source["sourceSigningRecipes"],"mutations":mutations,"methods":{"normalizeRequest":true,"plan":true,"validate":true,"finalize":true},"productionCoreInvoked":true,"normalization":"signature-neutral"}));
}
