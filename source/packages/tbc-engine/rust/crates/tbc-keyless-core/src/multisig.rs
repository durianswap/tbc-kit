//! SDK-compatible M-of-N wallets, not MuSig2. Public material only.
//! No keys, network, coordinator, approval, persistence or automatic broadcast.
use k256::ecdsa::{Signature, VerifyingKey, signature::hazmat::PrehashVerifier};
use serde::{Deserialize, Serialize};
use serde_json::json;
use std::collections::{BTreeMap, BTreeSet};
use tbc_sdk::{
    Address, DEFAULT_SIGHASH, MultiSig, OutPoint, PublicKey, Transaction, TxIn, TxOut,
    contracts::ft::{
        amount::{balance_from_tape, build_tape_amount},
        scripts::{FtCodeReceiver, transfer_code_script, transfer_tape_script},
        unlock::{
            classify_ft_script, contract_tx_data, current_inputs_data, current_tx_data,
            pre_pre_tx_data_from_parents, pre_tx_data,
        },
    },
    contracts::stable_coin::scripts::get_lock_time_from_tape,
    hash,
    script::Script,
};

type R<T> = Result<T, String>;
const MAX_MONEY: u64 = 2_100_000_000_000_000;
const MAX_BYTES: usize = 16 * 1024 * 1024;
const DUST: u64 = 42;

#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Group {
    public_keys: Vec<String>,
    required_signatures: u8,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    key_order: Option<KeyOrder>,
}
#[derive(Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
enum KeyOrder {
    Canonical,
    Provided,
}

#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Input {
    txid: String,
    vout: u32,
    satoshis: String,
    script_pub_key: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    parent_txraw: Option<String>,
}
#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct TokenInput {
    input: Input,
    balance: String,
    ancestors: Vec<String>,
}
#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Token {
    code: String,
    tape: String,
    inputs: Vec<TokenInput>,
}

#[derive(Clone, Serialize, Deserialize)]
#[serde(
    tag = "type",
    rename_all = "camelCase",
    rename_all_fields = "camelCase",
    deny_unknown_fields
)]
enum Action {
    Create {
        public_key: String,
        amount: String,
        inputs: Vec<Input>,
    },
    DepositTbc {
        public_key: String,
        amount: String,
        inputs: Vec<Input>,
    },
    TransferTbc {
        destination: String,
        amount: String,
        inputs: Vec<Input>,
    },
    MergeTbc {
        inputs: Vec<Input>,
    },
    DepositFt {
        public_key: String,
        amount: String,
        funding: Input,
        token: Token,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        tbc_amount: Option<String>,
    },
    TransferFt {
        public_key: String,
        destination: String,
        amount: String,
        funding: Input,
        token: Token,
    },
    MergeFt {
        public_key: String,
        funding: Input,
        token: Token,
    },
}
#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Request {
    chain_id: String,
    group: Group,
    action: Action,
    max_fee: String,
}
#[derive(Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Task {
    input_index: usize,
    digest: String,
    public_keys: Vec<String>,
    required_signatures: usize,
}
#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Proposal {
    format: String,
    proposal_id: String,
    request: Request,
    address: String,
    unsigned_txraw: String,
    fee: String,
    tasks: Vec<Task>,
}
#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Partial {
    proposal_id: String,
    input_index: usize,
    public_key: String,
    signature: String,
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct WithPartials {
    proposal: Proposal,
    signatures: Vec<Partial>,
}

enum Witness {
    P2pkh(Vec<u8>),
    Multi,
    Token {
        key: Vec<u8>,
        parent: Transaction,
        pre_pre: Vec<u8>,
        contract: Option<Transaction>,
        version: u8,
        coin: bool,
    },
}
struct Built {
    proposal: Proposal,
    tx: Transaction,
    inputs: Vec<Input>,
    witnesses: Vec<Witness>,
    keys: Vec<Vec<u8>>,
}

fn parse<T: for<'a> Deserialize<'a>>(s: &str) -> R<T> {
    if s.len() > MAX_BYTES {
        return Err("Multisig material exceeds limit".into());
    }
    serde_json::from_str(s).map_err(|_| "Invalid multisig schema".into())
}
fn sdk<T>(v: tbc_sdk::Result<T>) -> R<T> {
    v.map_err(|_| "Invalid multisig transaction material".into())
}
fn raw(s: &str) -> R<Vec<u8>> {
    if s.len() % 2 != 0
        || s.bytes()
            .any(|b| !b.is_ascii_hexdigit() || b.is_ascii_uppercase())
    {
        return Err("Canonical lowercase hex required".into());
    }
    hex::decode(s).map_err(|_| "Invalid hex".into())
}
fn key(s: &str) -> R<Vec<u8>> {
    let b = raw(s)?;
    if b.len() != 33 {
        return Err("Compressed public key required".into());
    }
    VerifyingKey::from_sec1_bytes(&b).map_err(|_| "Invalid public key")?;
    Ok(b)
}
fn amount(s: &str) -> R<u64> {
    if s.is_empty() || (s.len() > 1 && s.starts_with('0')) || !s.bytes().all(|b| b.is_ascii_digit())
    {
        return Err("Canonical atomic integer required".into());
    }
    s.parse::<u64>().map_err(|_| "Amount overflow".into())
}
fn money(s: &str) -> R<u64> {
    let a = amount(s)?;
    if a > MAX_MONEY {
        Err("Amount exceeds MoneyRange".into())
    } else {
        Ok(a)
    }
}
fn ordinary(s: &str) -> R<u64> {
    let a = money(s)?;
    if a < DUST {
        Err("Dust output".into())
    } else {
        Ok(a)
    }
}
fn script(s: &str) -> R<Script> {
    Ok(Script::from_bytes(raw(s)?))
}
fn transaction(s: &str) -> R<Transaction> {
    let tx = sdk(Transaction::from_hex(s))?;
    if tx.to_hex() != s {
        return Err("Noncanonical transaction".into());
    }
    Ok(tx)
}
fn point(i: &Input) -> R<OutPoint> {
    if i.txid.len() != 64 {
        return Err("Invalid outpoint".into());
    }
    raw(&i.txid)?;
    if i.vout == u32::MAX && i.txid == "00".repeat(32) {
        return Err("Null input".into());
    }
    Ok(OutPoint {
        txid: i.txid.parse().map_err(|_| "Invalid txid")?,
        vout: i.vout,
    })
}
fn parent(i: &Input) -> R<Transaction> {
    let p = transaction(
        i.parent_txraw
            .as_ref()
            .ok_or("Token/funding parent required")?,
    )?;
    if p.txid().to_string() != i.txid
        || p.outputs.get(i.vout as usize)
            != Some(&TxOut {
                satoshis: money(&i.satoshis)?,
                script_pubkey: script(&i.script_pub_key)?,
            })
    {
        return Err("Parent output mismatch".into());
    }
    Ok(p)
}
fn group(g: &Group) -> R<(String, Vec<Vec<u8>>)> {
    let keys = g
        .public_keys
        .iter()
        .map(|k| key(k))
        .collect::<R<Vec<_>>>()?;
    if g.key_order != Some(KeyOrder::Provided) && keys.windows(2).any(|w| w[0] >= w[1]) {
        return Err("Group keys must be unique and sorted".into());
    }
    let public = keys
        .iter()
        .map(|k| sdk(PublicKey::from_slice(k)))
        .collect::<R<Vec<_>>>()?;
    Ok((
        sdk(MultiSig::address_ordered(&public, g.required_signatures))?,
        keys,
    ))
}
pub fn describe(s: &str) -> R<String> {
    let mut g: Group = parse(s)?;
    if g.key_order != Some(KeyOrder::Provided) {
        g.public_keys.sort();
    }
    let (address, _) = group(&g)?;
    Ok(json!({"group":g,"address":address,"scriptPubKey":hex::encode(sdk(MultiSig::lock_script(&address))?.as_bytes()),
        "tokenOwner":hex::encode(sdk(MultiSig::combine_hash(&address))?)}).to_string())
}
pub fn decode_address(s: &str) -> R<String> {
    #[derive(Deserialize)]
    #[serde(deny_unknown_fields)]
    struct Query {
        address: String,
    }
    let q: Query = parse(s)?;
    let info = sdk(MultiSig::address_info(&q.address))?;
    Ok(
        json!({"address":q.address,"requiredSignatures":info.required_signatures,
        "publicKeyCount":info.public_key_count,
        "scriptPubKey":hex::encode(sdk(MultiSig::lock_script(&q.address))?.as_bytes()),
        "tokenOwner":hex::encode(sdk(MultiSig::combine_hash(&q.address))?)})
        .to_string(),
    )
}
fn destination(s: &str) -> R<Script> {
    if MultiSig::validate_address(s) {
        sdk(MultiSig::lock_script(s))
    } else {
        Ok(sdk(Address::from_string(s))?.script_pubkey())
    }
}
fn receiver(s: &str) -> R<FtCodeReceiver> {
    if MultiSig::validate_address(s) {
        Ok(FtCodeReceiver::ContractHash(sdk(MultiSig::combine_hash(
            s,
        ))?))
    } else {
        Ok(FtCodeReceiver::Address(sdk(Address::from_string(s))?))
    }
}
fn owner(k: &[u8]) -> Script {
    Script::p2pkh(&hash::hash160(k))
}
fn push(bytes: &mut Vec<u8>, value: &[u8]) {
    let mut s = Script::empty();
    s.push_data(value);
    bytes.extend_from_slice(s.as_bytes());
}
fn witness(
    tx: &Transaction,
    index: usize,
    input: &Input,
    w: &Witness,
    signatures: &[Vec<u8>],
    keys: &[Vec<u8>],
) -> R<Script> {
    let mut bytes = Vec::new();
    match w {
        Witness::P2pkh(k) => {
            push(&mut bytes, &signatures[0]);
            push(&mut bytes, k);
        }
        Witness::Multi => {
            bytes.push(0);
            for sig in signatures {
                push(&mut bytes, sig);
            }
            push(&mut bytes, &keys.concat());
        }
        Witness::Token {
            key,
            parent,
            pre_pre,
            contract,
            version,
            coin,
        } => {
            bytes = sdk(current_tx_data(tx, index))?;
            bytes.extend_from_slice(pre_pre);
            push(&mut bytes, &signatures[0]);
            push(&mut bytes, key);
            if let Some(p) = contract {
                bytes.extend(sdk(current_inputs_data(tx))?);
                bytes.extend(sdk(contract_tx_data(
                    p,
                    if *version > 1 {
                        -1
                    } else {
                        tx.inputs[0].previous_output.vout as i32
                    },
                ))?);
                if *version > 2 {
                    bytes.push(0);
                }
                if *coin {
                    bytes.push(0x51);
                }
            } else if *coin {
                bytes.push(0);
            }
            bytes.extend(sdk(pre_tx_data(parent, input.vout as usize))?);
        }
    }
    Ok(Script::from_bytes(bytes))
}

fn build(mut r: Request) -> R<Built> {
    if r.chain_id != "tbc:mainnet" && r.chain_id != "tbc:testnet" {
        return Err("Unsupported TBC chain".into());
    }
    // Normalize once before the proposal commitment. Import checks require this
    // exact canonical form; sorting never mutates a historical address silently.
    if r.group.key_order != Some(KeyOrder::Provided) {
        r.group.public_keys.sort();
    }
    let (address, keys) = group(&r.group)?;
    let lock = sdk(MultiSig::lock_script(&address))?;
    let max_fee = money(&r.max_fee)?;
    let tx = Transaction::new();
    let mut inputs = Vec::new();
    let mut witnesses = Vec::new();
    let mut outputs: Vec<TxOut> = Vec::new();
    let change_script: Script;
    let change_index: usize;
    let mut floor = 80;
    let mut required_change = false;
    let mut merge_native = false;
    match &r.action {
        Action::Create {
            public_key,
            amount: amt,
            inputs: ins,
        }
        | Action::DepositTbc {
            public_key,
            amount: amt,
            inputs: ins,
        } => {
            let k = key(public_key)?;
            change_script = owner(&k);
            for i in ins {
                if script(&i.script_pub_key)? != change_script {
                    return Err("Funding owner mismatch".into());
                }
                inputs.push(i.clone());
                witnesses.push(Witness::P2pkh(k.clone()));
            }
            outputs.push(TxOut {
                satoshis: ordinary(amt)?,
                script_pubkey: lock.clone(),
            });
            if matches!(r.action, Action::Create { .. }) {
                use tbc_sdk::contracts::multisig::scripts::{hold_script, tape_script};
                let public = keys
                    .iter()
                    .map(|k| sdk(PublicKey::from_slice(k)))
                    .collect::<R<Vec<_>>>()?;
                for k in &public {
                    outputs.push(TxOut {
                        satoshis: 200,
                        script_pubkey: hold_script(k),
                    });
                }
                let tape = if r.group.key_order == Some(KeyOrder::Provided) {
                    let value = format!(
                        "{{\"address\":\"{}\",\"pubkeys\":{}}}",
                        address,
                        serde_json::to_string(&r.group.public_keys).unwrap()
                    );
                    Script::op_return(&[value.into_bytes(), b"MTape".to_vec()])
                } else {
                    sdk(tape_script(&address, &public))?
                };
                outputs.push(TxOut {
                    satoshis: 0,
                    script_pubkey: tape,
                });
            }
            change_index = outputs.len();
        }
        Action::TransferTbc {
            destination: dest,
            amount: amt,
            inputs: ins,
        } => {
            change_script = lock.clone();
            change_index = 0;
            floor = 1000;
            for i in ins {
                if script(&i.script_pub_key)? != lock {
                    return Err("Multisig input owner mismatch".into());
                }
                inputs.push(i.clone());
                witnesses.push(Witness::Multi);
            }
            outputs.push(TxOut {
                satoshis: ordinary(amt)?,
                script_pubkey: destination(dest)?,
            });
        }
        Action::MergeTbc { inputs: ins } => {
            change_script = lock.clone();
            change_index = 0;
            floor = 1000;
            merge_native = true;
            if ins.len() < 2 {
                return Err("Merge needs at least two inputs".into());
            }
            for i in ins {
                if script(&i.script_pub_key)? != lock {
                    return Err("Multisig input owner mismatch".into());
                }
                inputs.push(i.clone());
                witnesses.push(Witness::Multi);
            }
        }
        Action::DepositFt {
            public_key,
            amount: amt,
            funding,
            token,
            tbc_amount,
        } => {
            let k = key(public_key)?;
            change_script = owner(&k);
            if script(&funding.script_pub_key)? != change_script {
                return Err("Funding owner mismatch".into());
            }
            if let Some(value) = tbc_amount {
                outputs.push(TxOut {
                    satoshis: ordinary(value)?,
                    script_pubkey: lock.clone(),
                });
            }
            append_token(
                &mut inputs,
                &mut witnesses,
                &mut outputs,
                token,
                &k,
                &address,
                FtCodeReceiver::Address(sdk(PublicKey::from_slice(&k))?.address()),
                FtCodeReceiver::Address(sdk(PublicKey::from_slice(&k))?.address()),
                amount(amt)?,
                None,
            )?;
            inputs.push(funding.clone());
            witnesses.push(Witness::P2pkh(k));
            change_index = outputs.len();
        }
        Action::TransferFt {
            public_key,
            destination: dest,
            amount: amt,
            funding,
            token,
        } => {
            let k = key(public_key)?;
            if !keys.contains(&k) {
                return Err("Token helper signer must be a group member".into());
            }
            if script(&funding.script_pub_key)? != lock || funding.vout != 0 {
                return Err(
                    "Token spend needs multisig funding at output zero; merge first".into(),
                );
            }
            let p = parent(funding)?;
            inputs.push(funding.clone());
            witnesses.push(Witness::Multi);
            append_token(
                &mut inputs,
                &mut witnesses,
                &mut outputs,
                token,
                &k,
                dest,
                FtCodeReceiver::ContractHash(sdk(MultiSig::combine_hash(&address))?),
                FtCodeReceiver::ContractHash(sdk(MultiSig::combine_hash(&address))?),
                amount(amt)?,
                Some(p),
            )?;
            change_script = lock.clone();
            change_index = 0;
            floor = 1000;
            required_change = true;
        }
        Action::MergeFt {
            public_key,
            funding,
            token,
        } => {
            let k = key(public_key)?;
            if !keys.contains(&k) {
                return Err("Token helper signer must be a group member".into());
            }
            if token.inputs.len() < 2 {
                return Err("FT merge needs at least two inputs".into());
            }
            if script(&funding.script_pub_key)? != lock || funding.vout != 0 {
                return Err(
                    "Token spend needs multisig funding at output zero; merge first".into(),
                );
            }
            let p = parent(funding)?;
            let total = token.inputs.iter().try_fold(0u64, |n, i| {
                n.checked_add(amount(&i.balance)?)
                    .ok_or_else(|| "Token amount overflow".to_owned())
            })?;
            inputs.push(funding.clone());
            witnesses.push(Witness::Multi);
            append_token(
                &mut inputs,
                &mut witnesses,
                &mut outputs,
                token,
                &k,
                &address,
                FtCodeReceiver::ContractHash(sdk(MultiSig::combine_hash(&address))?),
                FtCodeReceiver::ContractHash(sdk(MultiSig::combine_hash(&address))?),
                total,
                Some(p),
            )?;
            change_script = lock.clone();
            change_index = 0;
            floor = 1000;
            required_change = true;
        }
    }
    finish_build(
        r,
        address,
        keys,
        tx,
        inputs,
        witnesses,
        outputs,
        change_script,
        change_index,
        floor,
        required_change,
        merge_native,
        max_fee,
    )
}

#[allow(clippy::too_many_arguments)]
fn append_token(
    inputs: &mut Vec<Input>,
    witnesses: &mut Vec<Witness>,
    outputs: &mut Vec<TxOut>,
    token: &Token,
    k: &[u8],
    dest: &str,
    expected_owner: FtCodeReceiver,
    change_owner: FtCodeReceiver,
    amount: u64,
    contract: Option<Transaction>,
) -> R<()> {
    if amount == 0 || token.inputs.is_empty() || token.inputs.len() > 5 {
        return Err("Token amount/input count invalid".into());
    }
    let code = script(&token.code)?;
    let tape = script(&token.tape)?;
    let info = sdk(classify_ft_script(&code))?;
    let expected = sdk(transfer_code_script(&code, expected_owner))?;
    let mut balances = Vec::new();
    if contract.is_some() {
        balances.push(0);
    }
    for item in &token.inputs {
        if item.ancestors.len() > 12 {
            return Err("Too many token ancestors".into());
        }
        if script(&item.input.script_pub_key)? != expected {
            return Err("Token contract/owner mismatch".into());
        }
        let p = parent(&item.input)?;
        let t = p
            .outputs
            .get(item.input.vout as usize + 1)
            .ok_or("Missing adjacent token Tape")?;
        let _pair = sdk(tbc_sdk::validator::inspect_multisig_token_pair(
            &p.outputs[item.input.vout as usize],
            Some(t),
        ))?
        .ok_or("Unrecognized multisig Token template")?;
        let balance = self::amount(&item.balance)?;
        if balance == 0 || sdk(balance_from_tape(&t.script_pubkey))? != u128::from(balance) {
            return Err("Token balance mismatch".into());
        }
        // Code commits the asset identity. Plain FT immutable Tape metadata
        // must also agree. Coin's per-output lock time is mutable and checked
        // separately against sequence/nLockTime, never overwritten here.
        if !info.is_coin
            && sdk(transfer_tape_script(&t.script_pubkey, &[0; 48]))?
                != sdk(transfer_tape_script(&tape, &[0; 48]))?
        {
            return Err("Token metadata mismatch".into());
        }
        let ancestors = item
            .ancestors
            .iter()
            .map(|r| transaction(r))
            .collect::<R<Vec<_>>>()?;
        let pre_pre = sdk(pre_pre_tx_data_from_parents(
            &p,
            item.input.vout as usize,
            &ancestors,
        ))?;
        balances.push(u128::from(balance));
        inputs.push(item.input.clone());
        witnesses.push(Witness::Token {
            key: k.to_vec(),
            parent: p,
            pre_pre,
            contract: contract.clone(),
            version: info.version,
            coin: info.is_coin,
        });
    }
    let total = balances.iter().sum::<u128>();
    let (sent, change) = sdk(build_tape_amount(u128::from(amount), &balances))?;
    outputs.push(TxOut {
        satoshis: 2000,
        script_pubkey: sdk(transfer_code_script(&code, receiver(dest)?))?,
    });
    outputs.push(TxOut {
        satoshis: 0,
        script_pubkey: sdk(transfer_tape_script(&tape, &sent))?,
    });
    if u128::from(amount) < total {
        outputs.push(TxOut {
            satoshis: 2000,
            script_pubkey: sdk(transfer_code_script(&code, change_owner))?,
        });
        outputs.push(TxOut {
            satoshis: 0,
            script_pubkey: sdk(transfer_tape_script(&tape, &change))?,
        });
    }
    Ok(())
}

// Kept separate so all operations, including merge, use the same fee sizing,
// digest generation, proposal commitment and external-signature finalization.
#[allow(clippy::too_many_arguments)]
fn finish_build(
    r: Request,
    address: String,
    keys: Vec<Vec<u8>>,
    mut tx: Transaction,
    inputs: Vec<Input>,
    witnesses: Vec<Witness>,
    mut outputs: Vec<TxOut>,
    change_script: Script,
    change_index: usize,
    floor: u64,
    required_change: bool,
    merge_native: bool,
    max_fee: u64,
) -> R<Built> {
    if inputs.is_empty() || inputs.len() > 1000 || inputs.len() != witnesses.len() {
        return Err("Invalid multisig input count".into());
    }
    let mut seen = BTreeSet::new();
    let mut total = 0u64;
    for input in &inputs {
        let p = point(input)?;
        if !seen.insert((input.txid.clone(), input.vout)) {
            return Err("Duplicate input".into());
        }
        let a = money(&input.satoshis)?;
        if a == 0 {
            return Err("Zero-value input".into());
        }
        total = total
            .checked_add(a)
            .filter(|v| *v <= MAX_MONEY)
            .ok_or("Input sum exceeds MoneyRange")?;
        if input.parent_txraw.is_some() {
            parent(input)?;
        }
        tx.inputs.push(TxIn::new(p));
    }
    // StableCoin requires sequence and maximum lock time even for contract-owned spends.
    for (i, w) in witnesses.iter().enumerate() {
        if let Witness::Token {
            parent, coin: true, ..
        } = w
        {
            let tape = parent
                .outputs
                .get(inputs[i].vout as usize + 1)
                .ok_or("Missing stablecoin Tape")?;
            tx.lock_time = tx
                .lock_time
                .max(sdk(get_lock_time_from_tape(&tape.script_pubkey))?);
            tx.inputs[i].sequence = u32::MAX - 1;
        }
    }
    let outgoing = outputs.iter().try_fold(0u64, |sum, o| {
        sum.checked_add(o.satoshis).ok_or("Output overflow")
    })?;
    outputs.insert(
        change_index,
        TxOut {
            satoshis: DUST,
            script_pubkey: change_script,
        },
    );
    tx.outputs = outputs;
    // Size complete witnesses using maximum DER lengths; never sign/re-sign to
    // estimate fees. This also bounds the final serialized-size fee check.
    let mut estimated = tx.clone();
    for (i, w) in witnesses.iter().enumerate() {
        let n = if matches!(w, Witness::Multi) {
            r.group.required_signatures as usize
        } else {
            1
        };
        estimated.inputs[i].script_sig =
            witness(&tx, i, &inputs[i], w, &vec![vec![0; 73]; n], &keys)?;
    }
    let fee = ((estimated.serialize().len() as u64 * 80 + 999) / 1000).max(floor);
    let change = total
        .checked_sub(outgoing)
        .and_then(|n| n.checked_sub(fee))
        .ok_or("Insufficient funds")?;
    if change < DUST {
        if required_change || merge_native {
            return Err("Insufficient funding change".into());
        }
        tx.outputs.remove(change_index);
    } else {
        tx.outputs[change_index].satoshis = change;
    }
    let paid = total - tx.outputs.iter().map(|o| o.satoshis).sum::<u64>();
    if paid > max_fee {
        return Err("Multisig fee exceeds approval ceiling".into());
    }
    let tasks = inputs
        .iter()
        .zip(&witnesses)
        .enumerate()
        .map(|(i, (input, w))| {
            Ok(Task {
                input_index: i,
                digest: hex::encode(sdk(tx.sighash_digest(
                    i,
                    &script(&input.script_pub_key)?,
                    money(&input.satoshis)?,
                    DEFAULT_SIGHASH,
                ))?),
                public_keys: match w {
                    Witness::Multi => r.group.public_keys.clone(),
                    Witness::P2pkh(k) | Witness::Token { key: k, .. } => vec![hex::encode(k)],
                },
                required_signatures: if matches!(w, Witness::Multi) {
                    r.group.required_signatures as usize
                } else {
                    1
                },
            })
        })
        .collect::<R<Vec<_>>>()?;
    let mut proposal = Proposal {
        format: "tbc-multisig-proposal".into(),
        proposal_id: String::new(),
        request: r,
        address,
        unsigned_txraw: tx.to_hex(),
        fee: paid.to_string(),
        tasks,
    };
    proposal.proposal_id = hex::encode(hash::sha256d(
        &serde_json::to_vec(&proposal).map_err(|_| "Proposal encoding failed")?,
    ));
    Ok(Built {
        proposal,
        tx,
        inputs,
        witnesses,
        keys,
    })
}

fn revalidate(p: Proposal) -> R<Built> {
    let b = build(p.request.clone())?;
    if serde_json::to_value(&p).unwrap() != serde_json::to_value(&b.proposal).unwrap() {
        return Err("Multisig proposal binding mismatch".into());
    }
    Ok(b)
}
pub fn prepare(s: &str) -> R<String> {
    Ok(serde_json::to_string(&build(parse(s)?)?.proposal).unwrap())
}
pub fn inspect(s: &str) -> R<String> {
    let b = revalidate(parse(s)?)?;
    Ok(serde_json::to_string(&b.proposal).unwrap())
}
fn verified(b: &Built, partials: &[Partial]) -> R<BTreeMap<(usize, String), Vec<u8>>> {
    if partials.len() > b.inputs.len() * b.keys.len() {
        return Err("Too many signatures".into());
    }
    let mut result = BTreeMap::new();
    for p in partials {
        if p.proposal_id != b.proposal.proposal_id {
            return Err("Signature belongs to a different proposal".into());
        }
        let task = b
            .proposal
            .tasks
            .get(p.input_index)
            .ok_or("Unknown signing task")?;
        if !task.public_keys.contains(&p.public_key) {
            return Err("Signer is not authorized for input".into());
        }
        let bytes = raw(&p.signature)?;
        if bytes.last() != Some(&(DEFAULT_SIGHASH as u8)) {
            return Err("Multisig requires SIGHASH_ALL|FORKID".into());
        }
        let sig =
            Signature::from_der(&bytes[..bytes.len() - 1]).map_err(|_| "Invalid DER signature")?;
        if sig.normalize_s().is_some() {
            return Err("Low-S signature required".into());
        }
        let vk =
            VerifyingKey::from_sec1_bytes(&key(&p.public_key)?).map_err(|_| "Invalid signer")?;
        vk.verify_prehash(&raw(&task.digest)?, &sig)
            .map_err(|_| "Multisig signature mismatch")?;
        if result
            .insert((p.input_index, p.public_key.clone()), bytes)
            .is_some()
        {
            return Err("Duplicate participant signature".into());
        }
    }
    Ok(result)
}
pub fn combine(s: &str, finalize: bool) -> R<String> {
    let r: WithPartials = parse(s)?;
    let mut b = revalidate(r.proposal)?;
    let verified = verified(&b, &r.signatures)?;
    let mut counts = Vec::new();
    let mut complete = true;
    for t in &b.proposal.tasks {
        let n = t
            .public_keys
            .iter()
            .filter(|k| verified.contains_key(&(t.input_index, (*k).clone())))
            .count();
        counts.push(n);
        complete &= n >= t.required_signatures;
    }
    if !finalize {
        return Ok(json!({"proposalId":b.proposal.proposal_id,"complete":complete,"signatureCounts":counts}).to_string());
    }
    if !complete {
        return Err("Multisig threshold not reached".into());
    }
    for (i, w) in b.witnesses.iter().enumerate() {
        let t = &b.proposal.tasks[i];
        let sigs = t
            .public_keys
            .iter()
            .filter_map(|k| verified.get(&(i, k.clone())).cloned())
            .take(t.required_signatures)
            .collect::<Vec<_>>();
        b.tx.inputs[i].script_sig = witness(&b.tx, i, &b.inputs[i], w, &sigs, &b.keys)?;
    }
    if money(&b.proposal.fee)? < (b.tx.serialize().len() as u64 * 80 + 999) / 1000 {
        return Err("Signed-size fee underfunded".into());
    }
    Ok(json!({"proposalId":b.proposal.proposal_id,"txraw":b.tx.to_hex(),"txid":b.tx.txid().to_string(),"fee":b.proposal.fee}).to_string())
}
