use std::{env, fs};

use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use tbc_sdk::{
    Address, DEFAULT_SEQUENCE, DEFAULT_SIGHASH, FtInfo, FtUtxo, OutPoint, PrivateKey,
    Transaction, TxIn, TxOut, Txid, Utxo, UtxoInfo,
    contracts::{
        ft::{
            amount::{balance_from_tape, build_tape_amount},
            partial_sha256::calculate_partial_hash,
            scripts::{
                FtCodeReceiver, FtMintVersion, mint_code_script_with_version,
                mint_source_script, mint_tape_script, transfer_code_script,
                transfer_tape_script,
            },
            unlock::{classify_ft_script, pre_pre_tx_data_from_parents},
        },
        pool_nft_v2::{
            FtSpendContext, FtlpCodeParams, FtlpTapeLayout, FtlpTapeParams, FtScriptVersion,
            FtlpSpendContext, LockedLpCost, LockedPoolCodeParams, PoolAmounts, PoolCodeParams,
            PoolFtAuthority, PoolInitContext, PoolNftV2, PoolOperationContext, PoolSpendContext,
            PoolState, ftlp_code,
            ftlp_lock_time_code, ftlp_tape, locked_pool_code, pool_code,
            pool_held_ft_code, pool_tape,
        },
    },
    hash, script::Script,
};

const PIN: &str = "923497e8b2473c0e179fa0b86dbb32a2f188d25a";
const PROVIDER: &str = "task-7";
const OWNER: &str = "1BgGZ9tcN4rm9KBzDn7KprQz87SZ26SAMH";
const OWNER_PUBLIC_KEY: [u8; 33] = [
    0x02, 0x79, 0xbe, 0x66, 0x7e, 0xf9, 0xdc, 0xbb, 0xac, 0x55, 0xa0, 0x62, 0x95, 0xce,
    0x87, 0x0b, 0x07, 0x02, 0x9b, 0xfc, 0xdb, 0x2d, 0xce, 0x28, 0xd9, 0x59, 0xf2, 0x81,
    0x5b, 0x16, 0xf8, 0x17, 0x98,
];

fn encode_hex(bytes: &[u8]) -> String {
    bytes.iter().map(|byte| format!("{byte:02x}")).collect()
}

fn transaction(outputs: Vec<TxOut>, seed: u8) -> Transaction {
    Transaction {
        version: tbc_sdk::TX_VERSION,
        inputs: vec![TxIn {
            previous_output: OutPoint { txid: Txid::from_le_bytes([seed; 32]), vout: 0 },
            script_sig: Script::from_bytes(vec![0x51, seed]),
            sequence: DEFAULT_SEQUENCE,
        }],
        outputs,
        lock_time: 0,
    }
}

fn unsigned(transaction: &Transaction) -> Transaction {
    let mut result = transaction.clone();
    for input in &mut result.inputs {
        input.script_sig = Script::empty();
    }
    result
}

fn released_plan(lp_plan: u8) -> (u16, &'static str) {
    match lp_plan {
        1 => (35, "13oCEJaqyyiC8iRrfup6PDL2GKZ3xQrsZL"),
        2 => (35, "1Fa6Uy64Ub4qNdB896zX2pNMx4a8zMhtCy"),
        3 => (135, "125fTLNsraQxTYqT4EeQNF2ggzcqicveKL"),
        4 => (335, "19DetoaaohQkjFVJ6oGXd83xhZYQSbpE1g"),
        5 => (535, "15EKrhuD8Yf3SfhjAgbizYqfnBbKh9ZMZ7"),
        6 => (130, "1N7rf2AuAHB2aCrVgnbQhSWhaUVk3rGhjm"),
        _ => panic!("released LP plan must be in 1..=6"),
    }
}

fn signed_pool_contract(
    source: &Transaction,
    owner: &PrivateKey,
    code: Script,
    tape: Script,
) -> Transaction {
    let fixed_output = 1_000u64;
    let mut change = source.outputs[0].satoshis - fixed_output;
    loop {
        let mut candidate = Transaction {
            version: tbc_sdk::TX_VERSION,
            inputs: vec![TxIn::new(OutPoint { txid: source.txid(), vout: 0 })],
            outputs: vec![
                TxOut { satoshis: fixed_output, script_pubkey: code.clone() },
                TxOut { satoshis: 0, script_pubkey: tape.clone() },
                TxOut { satoshis: change, script_pubkey: owner.address().script_pubkey() },
            ],
            lock_time: 0,
        };
        candidate
            .sign_p2pkh_input(
                0,
                owner,
                &source.outputs[0].script_pubkey,
                source.outputs[0].satoshis,
                DEFAULT_SIGHASH,
            )
            .expect("sign pinned-source Pool contract");
        let fee = ((candidate.serialize().len() as u64 * tbc_sdk::DEFAULT_FEE_RATE_SAT_PER_KB)
            .div_ceil(1_000))
            .max(tbc_sdk::DEFAULT_FEE_RATE_SAT_PER_KB);
        let next = source.outputs[0].satoshis - fixed_output - fee;
        if next == change {
            return candidate;
        }
        change = next;
    }
}

struct SourceCreateFixture {
    owner: PrivateKey,
    authority: PoolFtAuthority,
    pool_source: Transaction,
    pool_contract: Transaction,
    initialized: Transaction,
    owner_ft: Transaction,
    fee_parent: Transaction,
}

fn create_fixture_with_balance(
    lp_plan: u8,
    locked: bool,
    owner_ft_balance: u128,
) -> SourceCreateFixture {
    let (service_fee_rate, _) = released_plan(lp_plan);
    let mut owner_secret = [0u8; 32];
    owner_secret[31] = 1;
    let owner = PrivateKey::from_slice(&owner_secret).expect("deterministic source owner");
    assert_eq!(owner.to_bytes(), owner_secret);
    assert_eq!(owner.public_key().to_bytes(), OWNER_PUBLIC_KEY);
    assert_eq!(owner.address().to_string(), OWNER);
    let mut supply = [0u8; 48];
    supply[..8].copy_from_slice(&5_000_000u64.to_le_bytes());
    let ft_tape = mint_tape_script(&supply, 6, "Task Seven Token", "TST");
    let ft_source = transaction(
        vec![
            TxOut { satoshis: 9_900, script_pubkey: mint_source_script(&owner.address()) },
            TxOut { satoshis: 0, script_pubkey: ft_tape.clone() },
        ],
        0x31,
    );
    let ft_code = mint_code_script_with_version(
        &ft_source.txid().to_string(),
        0,
        &owner.address(),
        ft_tape.as_bytes().len(),
        FtMintVersion::V4,
    ).expect("released FT code");
    let ft_contract = Transaction {
        version: tbc_sdk::TX_VERSION,
        inputs: vec![TxIn::new(OutPoint { txid: ft_source.txid(), vout: 0 })],
        outputs: vec![
            TxOut { satoshis: 500, script_pubkey: ft_code.clone() },
            TxOut { satoshis: 0, script_pubkey: ft_tape.clone() },
        ],
        lock_time: 0,
    };
    let authority = PoolFtAuthority {
        info: FtInfo {
            contract_txid: Some(ft_contract.txid().to_string()),
            code_script: encode_hex(ft_code.as_bytes()),
            tape_script: encode_hex(ft_tape.as_bytes()),
            total_supply_raw: 5_000_000,
            decimal: 6,
            name: "Task Seven Token".to_owned(),
            symbol: "TST".to_owned(),
        },
        contract_tx: ft_contract.clone(),
    };
    let owned_ft_code = transfer_code_script(
        &ft_code,
        FtCodeReceiver::Address(owner.address()),
    ).expect("released owned FT code");
    let owner_ft = Transaction {
        version: tbc_sdk::TX_VERSION,
        inputs: vec![TxIn::new(OutPoint { txid: ft_contract.txid(), vout: 0 })],
        outputs: vec![
            TxOut { satoshis: 500, script_pubkey: owned_ft_code.clone() },
            TxOut {
                satoshis: 0,
                script_pubkey: transfer_tape_script(
                    &ft_tape,
                    &build_tape_amount(owner_ft_balance, &[owner_ft_balance]).expect("FT amount").0,
                ).expect("owned FT tape"),
            },
        ],
        lock_time: 0,
    };
    let source_script = Script::from_asm(&format!(
        "OP_DUP OP_HASH160 {} OP_EQUALVERIFY OP_CHECKSIG OP_RETURN {}",
        encode_hex(&owner.address().hash160()),
        encode_hex(b"for poolnft mint")
    )).expect("Pool source script");
    let pool_source = transaction(
        vec![TxOut { satoshis: 9_800, script_pubkey: source_script }],
        0x32,
    );
    let params = PoolCodeParams { lp_plan, ft_version: FtScriptVersion::V4, is_coin: false };
    let mut lock_keys = vec![
        PrivateKey::from_slice(&[3; 32]).unwrap().public_key(),
        owner.public_key(),
    ];
    lock_keys.sort_by_key(|key| key.to_bytes());
    let pool_code_script = if locked {
        locked_pool_code(
            OutPoint { txid: pool_source.txid(), vout: 0 },
            PROVIDER.as_bytes(),
            &lock_keys,
            &LockedPoolCodeParams {
                pool: params,
                lp_cost_address: owner.address(),
                lp_cost_sat: 100,
            },
        ).expect("released locked Pool code")
    } else {
        pool_code(
            OutPoint { txid: pool_source.txid(), vout: 0 },
            PROVIDER.as_bytes(),
            &params,
        ).expect("released Pool code")
    };
    let empty_ftlp_tape = if locked {
        ftlp_tape(&FtlpTapeParams {
            amount_raw: 0,
            layout: FtlpTapeLayout::LockTime {
                lock_time: 0,
                source_ft_tape_size: ft_tape.as_bytes().len(),
            },
        }).expect("locked empty FTLP tape")
    } else {
        ftlp_tape(&FtlpTapeParams {
            amount_raw: 0,
            layout: FtlpTapeLayout::Standard {
                decimal: 6,
                name: "Task Seven Token",
                symbol: "TST",
                is_coin: false,
            },
        }).expect("standard empty FTLP tape")
    };
    let ftlp_params = FtlpCodeParams::for_tape(
        &empty_ftlp_tape,
        FtScriptVersion::V4,
        false,
    ).expect("FTLP params");
    let ftlp_code_script = if locked {
        ftlp_lock_time_code(hash::sha256(pool_code_script.as_bytes()), &owner.address(), &ftlp_params)
            .expect("locked FTLP code")
    } else {
        ftlp_code(hash::sha256(pool_code_script.as_bytes()), &owner.address(), &ftlp_params)
            .expect("standard FTLP code")
    };
    let zero_state = PoolState {
        amounts: PoolAmounts { ft_lp_raw: 0, ft_a_raw: 0, tbc_sat: 0 },
        ft_lp_partial_hash: calculate_partial_hash(&ftlp_code_script.as_bytes()[..2048]).to_vec(),
        ft_a_partial_hash: calculate_partial_hash(&ft_code.as_bytes()[..2048]).to_vec(),
        ft_a_contract_id: ft_contract.txid(),
        service_fee_rate,
        service_provider: PROVIDER.to_owned(),
        lp_plan,
        public_key_locked: locked,
        ftlp_lock_time_enabled: locked,
    };
    let pool_contract = signed_pool_contract(
        &pool_source,
        &owner,
        pool_code_script.clone(),
        pool_tape(&zero_state).expect("zero Pool tape"),
    );
    let mut pool = PoolNftV2::for_create(ft_contract.txid(), authority.clone())
        .expect("pinned-source Pool authority");
    pool.contract_id = Some(pool_contract.txid());
    pool.state = zero_state.clone();
    pool.current_pool_value_sat = Some(pool_contract.outputs[0].satoshis);
    pool.pool_code = pool_code_script;
    let ft_pre_pre = pre_pre_tx_data_from_parents(
        &owner_ft,
        0,
        std::slice::from_ref(&ft_contract),
    ).expect("FT ancestry");
    let fee_parent = transaction(
        vec![TxOut { satoshis: 1_000_000, script_pubkey: owner.address().script_pubkey() }],
        0x33,
    );
    let fee = Utxo {
        outpoint: OutPoint { txid: fee_parent.txid(), vout: 0 },
        satoshis: fee_parent.outputs[0].satoshis,
        script_pubkey: fee_parent.outputs[0].script_pubkey.clone(),
        private_key: owner.clone(),
    };
    let context = PoolInitContext {
        pool: PoolSpendContext {
            pool_utxo: UtxoInfo {
                outpoint: OutPoint { txid: pool_contract.txid(), vout: 0 },
                satoshis: pool_contract.outputs[0].satoshis,
                script_pubkey: pool_contract.outputs[0].script_pubkey.clone(),
            },
            pool_pre_tx: pool_contract.clone(),
            pool_pre_pre_tx: pool_source.clone(),
            contract_tx: ft_contract.clone(),
            state: zero_state,
        },
        ft: tbc_sdk::contracts::pool_nft_v2::FtSpendContext {
            utxo: FtUtxo {
                base: Utxo {
                    outpoint: OutPoint { txid: owner_ft.txid(), vout: 0 },
                    satoshis: owner_ft.outputs[0].satoshis,
                    script_pubkey: owner_ft.outputs[0].script_pubkey.clone(),
                    private_key: owner.clone(),
                },
                ft_balance_raw: owner_ft_balance,
            },
            pre_tx: owner_ft.clone(),
            pre_pre_tx_data: ft_pre_pre,
        },
        ft_authority: authority.clone(),
        ft_grandparents: vec![ft_contract],
        fee_parent: fee_parent.clone(),
        lp_receiver: owner.address(),
        public_key_lock: if locked { lock_keys.clone() } else { vec![] },
    };
    let initialized = pool
        .init_pool(
            context,
            &owner,
            fee.clone(),
            "0.01",
            "2.5",
            if locked { 800_100 } else { 0 },
        )
        .expect("released Pool init");
    SourceCreateFixture {
        owner,
        authority,
        pool_source,
        pool_contract,
        initialized,
        owner_ft,
        fee_parent,
    }
}

fn create_fixture(lp_plan: u8, locked: bool) -> SourceCreateFixture {
    create_fixture_with_balance(lp_plan, locked, 2_500_000)
}

struct SourceOperationFixture {
    owner: PrivateKey,
    pool: PoolNftV2,
    fee: Utxo,
    increase: PoolOperationContext,
    consume: PoolOperationContext,
}

fn unique_pair(transaction: &Transaction, code: &Script, tape: &Script, label: &str) -> usize {
    let matches = transaction.outputs.windows(2).enumerate()
        .filter(|(_, pair)| pair[0].script_pubkey == *code && pair[1].script_pubkey == *tape)
        .map(|(index, _)| index).collect::<Vec<_>>();
    assert_eq!(matches.len(), 1, "{label} must resolve to one exact released Code/Tape pair");
    matches[0]
}

fn parsed_ft_slots(tape: &Script) -> [u64; 6] {
    let bytes = tape.as_bytes();
    assert!(bytes.len() >= 56, "released FT Tape must include six amount slots and FTape marker");
    assert!(bytes.ends_with(b"FTape"), "released FT Tape marker");
    std::array::from_fn(|index| {
        let mut slot = [0u8; 8];
        slot.copy_from_slice(&bytes[3 + index * 8..11 + index * 8]);
        u64::from_le_bytes(slot)
    })
}

fn operation_fixture(locked: bool) -> SourceOperationFixture {
    let create = create_fixture_with_balance(1, locked, 5_000_000);
    let owner = create.owner.clone();
    let initialized = Transaction::from_hex(&create.initialized.to_hex())
        .expect("parse finalized released init transaction");
    let state = PoolState::from_v2_tape(
        &initialized.outputs[1].script_pubkey,
        PROVIDER.to_owned(),
    ).expect("initialized Pool state");
    let pool_code_script = initialized.outputs[0].script_pubkey.clone();
    let mut pool = PoolNftV2::for_create(
        create.authority.contract_tx.txid(),
        create.authority.clone(),
    ).expect("authenticated operation Pool authority");
    pool.contract_id = Some(create.pool_contract.txid());
    pool.state = state.clone();
    pool.current_pool_value_sat = Some(initialized.outputs[0].satoshis);
    pool.pool_code = pool_code_script.clone();

    let ft_code = create.authority.contract_tx.outputs[0].script_pubkey.clone();
    let ft_tape = create.authority.contract_tx.outputs[1].script_pubkey.clone();
    let owner_code = transfer_code_script(&ft_code, FtCodeReceiver::Address(owner.address()))
        .expect("released owner FT Code");
    let owner_matches = initialized.outputs.windows(2).enumerate()
        .filter(|(_, pair)| pair[0].script_pubkey == owner_code)
        .map(|(index, _)| index).collect::<Vec<_>>();
    assert_eq!(owner_matches.len(), 1, "owner FT Code must resolve uniquely from finalized init bytes");
    let owner_index = owner_matches[0];
    let owner_info = classify_ft_script(&initialized.outputs[owner_index].script_pubkey)
        .expect("released owner FT Code classification");
    assert_eq!((owner_info.version, owner_info.is_coin), (4, false), "owner FT version/coin binding");
    assert_eq!(initialized.outputs[owner_index].satoshis, 500, "owner FT Code value");
    let owner_tape = &initialized.outputs[owner_index + 1];
    assert_eq!(owner_tape.satoshis, 0, "owner FT Tape value");
    let expected_change = 5_000_000u128.checked_sub(2_500_000).expect("checked FT change");
    assert_eq!(balance_from_tape(&owner_tape.script_pubkey).expect("released owner FT Tape"), expected_change);
    let slots = parsed_ft_slots(&owner_tape.script_pubkey);
    assert_eq!(slots[1], expected_change as u64, "owner FT change must retain init input slot 1");
    assert!(slots.iter().enumerate().all(|(index, amount)| index == 1 || *amount == 0),
        "owner FT change must not move value to another input slot");

    let pool_hash = hash::sha256(pool_code_script.as_bytes());
    let reserve_code = pool_held_ft_code(&ft_code, hash::hash160(&pool_hash))
        .expect("released Pool-held FT Code");
    let reserve_matches = initialized.outputs.windows(2).enumerate()
        .filter(|(_, pair)| pair[0].script_pubkey == reserve_code)
        .map(|(index, _)| index).collect::<Vec<_>>();
    assert_eq!(reserve_matches.len(), 1, "Pool-held FT Code must resolve uniquely");
    let reserve_index = reserve_matches[0];
    let reserve_tape = &initialized.outputs[reserve_index + 1].script_pubkey;
    assert_eq!(balance_from_tape(reserve_tape).expect("released reserve FT Tape"), 2_500_000);

    let ftlp_tape_script = if locked {
        ftlp_tape(&FtlpTapeParams {
            amount_raw: state.amounts.ft_lp_raw,
            layout: FtlpTapeLayout::LockTime {
                lock_time: 800_100,
                source_ft_tape_size: ft_tape.as_bytes().len(),
            },
        }).expect("released initialized locked FTLP Tape")
    } else {
        ftlp_tape(&FtlpTapeParams {
            amount_raw: state.amounts.ft_lp_raw,
            layout: FtlpTapeLayout::Standard {
                decimal: 6,
                name: "Task Seven Token",
                symbol: "TST",
                is_coin: false,
            },
        }).expect("released initialized FTLP Tape")
    };
    let ftlp_params = FtlpCodeParams::for_tape(&ftlp_tape_script, FtScriptVersion::V4, false)
        .expect("released FTLP params");
    let ftlp_code_script = if locked {
        ftlp_lock_time_code(pool_hash, &owner.address(), &ftlp_params).expect("released locked FTLP Code")
    } else {
        ftlp_code(pool_hash, &owner.address(), &ftlp_params).expect("released FTLP Code")
    };
    let ftlp_index = unique_pair(&initialized, &ftlp_code_script, &ftlp_tape_script, "initialized FTLP");
    let authenticated_lp_raw = balance_from_tape(&initialized.outputs[ftlp_index + 1].script_pubkey)
        .expect("authenticated initialized FTLP amount");
    assert_eq!(authenticated_lp_raw, u128::from(state.amounts.ft_lp_raw),
        "initialized FTLP Tape must equal authenticated live Pool LP total");

    let spend = |vout: usize, balance: u128| FtSpendContext {
        utxo: FtUtxo { base: Utxo {
            outpoint: OutPoint { txid: initialized.txid(), vout: vout as u32 },
            satoshis: initialized.outputs[vout].satoshis,
            script_pubkey: initialized.outputs[vout].script_pubkey.clone(),
            private_key: owner.clone(),
        }, ft_balance_raw: balance },
        pre_tx: initialized.clone(),
        pre_pre_tx_data: pre_pre_tx_data_from_parents(
            &initialized, vout, std::slice::from_ref(&create.owner_ft),
        ).expect("initialized FT ancestry"),
    };
    let ftlp = FtlpSpendContext {
        utxo: tbc_sdk::FtlpUtxo { base: UtxoInfo {
            outpoint: OutPoint { txid: initialized.txid(), vout: ftlp_index as u32 },
            satoshis: initialized.outputs[ftlp_index].satoshis,
            script_pubkey: initialized.outputs[ftlp_index].script_pubkey.clone(),
        }, ft_balance_raw: authenticated_lp_raw },
        pre_tx: initialized.clone(),
        pre_pre_tx_data: pre_pre_tx_data_from_parents(
            &initialized, ftlp_index, std::slice::from_ref(&create.pool_contract),
        ).expect("initialized FTLP ancestry"),
        grandparents: vec![create.pool_contract.clone()],
        pool: None,
        fee_parent: None,
    };
    let pool_spend = PoolSpendContext {
        pool_utxo: UtxoInfo {
            outpoint: OutPoint { txid: initialized.txid(), vout: 0 },
            satoshis: initialized.outputs[0].satoshis,
            script_pubkey: pool_code_script,
        },
        pool_pre_tx: initialized.clone(),
        pool_pre_pre_tx: create.pool_contract.clone(),
        contract_tx: create.authority.contract_tx,
        state,
    };
    let fee_parent = transaction(vec![TxOut {
        satoshis: 1_000_000,
        script_pubkey: owner.address().script_pubkey(),
    }], 0x34);
    let fee = Utxo {
        outpoint: OutPoint { txid: fee_parent.txid(), vout: 0 },
        satoshis: fee_parent.outputs[0].satoshis,
        script_pubkey: fee_parent.outputs[0].script_pubkey.clone(),
        private_key: owner.clone(),
    };
    let lock_keys = if locked {
        let mut keys = vec![PrivateKey::from_slice(&[3; 32]).unwrap().public_key(), owner.public_key()];
        keys.sort_by_key(|key| key.to_bytes());
        keys
    } else { vec![] };
    let locked_lp_cost = locked.then_some(LockedLpCost { address: owner.address(), satoshis: 100 });
    let operation = |ft_inputs, ftlp_inputs, ft_grandparents, ftlp_grandparents| PoolOperationContext {
        pool: pool_spend.clone(), ft_inputs, ftlp_inputs, ft_grandparents, ftlp_grandparents,
        fee_parent: fee_parent.clone(), public_key_lock: lock_keys.clone(),
        locked_lp_cost: locked_lp_cost.clone(),
    };
    let increase = operation(
        vec![spend(owner_index, 2_500_000)], vec![], vec![vec![create.owner_ft.clone()]], vec![],
    );
    let consume = operation(
        vec![spend(reserve_index, 2_500_000)], vec![ftlp],
        vec![vec![create.owner_ft]], vec![vec![create.pool_contract]],
    );
    SourceOperationFixture { owner, pool, fee, increase, consume }
}

fn tx_evidence(id: &str, stage: usize, role: &str, dependencies: &[&str], tx: &Transaction) -> Value {
    json!({
        "templateId": id,
        "stage": stage,
        "role": role,
        "dependencies": dependencies,
        "publicIntent": if role == "primary" { Some(id) } else { None },
        "unsignedRaw": unsigned(tx).to_hex(),
        "finalizedRaw": tx.to_hex(),
    })
}

fn distinct_pool_ft_inputs(
    fixture: &SourceOperationFixture,
    amounts: &[u64],
) -> (Vec<FtSpendContext>, Vec<Vec<Transaction>>) {
    let template = &fixture.consume.ft_inputs[0];
    let code = template.utxo.base.script_pubkey.clone();
    let tape = template.pre_tx.outputs[template.utxo.base.outpoint.vout as usize + 1]
        .script_pubkey.clone();
    amounts.iter().enumerate().map(|(index, amount)| {
        let balance = u128::from(*amount);
        let grandparent = transaction(vec![TxOut { satoshis: 500, script_pubkey: code.clone() }], 0x80 + index as u8);
        let amount = build_tape_amount(balance, &[balance]).expect("Pool FT amount").0;
        let mut parent = transaction(vec![
            TxOut { satoshis: 500, script_pubkey: code.clone() },
            TxOut { satoshis: 0, script_pubkey: transfer_tape_script(&tape, &amount).expect("Pool FT tape") },
        ], 0x90 + index as u8);
        parent.inputs[0].previous_output = OutPoint { txid: grandparent.txid(), vout: 0 };
        let pre_pre_tx_data = pre_pre_tx_data_from_parents(&parent, 0, std::slice::from_ref(&grandparent))
            .expect("Pool FT ancestry");
        (FtSpendContext {
            utxo: FtUtxo { base: Utxo {
                outpoint: OutPoint { txid: parent.txid(), vout: 0 }, satoshis: 500,
                script_pubkey: code.clone(), private_key: fixture.owner.clone(),
            }, ft_balance_raw: balance },
            pre_tx: parent,
            pre_pre_tx_data,
        }, vec![grandparent])
    }).unzip()
}

fn distinct_ftlp_inputs(fixture: &SourceOperationFixture, amounts: &[u64]) -> Vec<FtlpSpendContext> {
    let template = &fixture.consume.ftlp_inputs[0];
    let code = template.utxo.base.script_pubkey.clone();
    let base_tape = template.pre_tx.outputs[template.utxo.base.outpoint.vout as usize + 1]
        .script_pubkey.clone();
    amounts.iter().enumerate().map(|(index, amount)| {
        let balance = u128::from(*amount);
        let grandparent = transaction(vec![TxOut { satoshis: 500, script_pubkey: code.clone() }], 0xa0 + index as u8);
        let tape = if fixture.pool.state.ftlp_lock_time_enabled {
            ftlp_tape(&FtlpTapeParams {
                amount_raw: balance as u64,
                layout: FtlpTapeLayout::LockTime {
                    lock_time: 800_100,
                    source_ft_tape_size: fixture.consume.ft_inputs[0].pre_tx.outputs[3].script_pubkey.as_bytes().len(),
                },
            }).expect("locked FTLP tape")
        } else {
            let amount = build_tape_amount(balance, &[balance]).expect("FTLP amount").0;
            transfer_tape_script(&base_tape, &amount).expect("standard FTLP tape")
        };
        let mut parent = transaction(vec![
            TxOut { satoshis: 500, script_pubkey: code.clone() },
            TxOut { satoshis: 0, script_pubkey: tape },
        ], 0xb0 + index as u8);
        parent.inputs[0].previous_output = OutPoint { txid: grandparent.txid(), vout: 0 };
        FtlpSpendContext {
            utxo: tbc_sdk::FtlpUtxo { base: UtxoInfo {
                outpoint: OutPoint { txid: parent.txid(), vout: 0 }, satoshis: 500,
                script_pubkey: code.clone(),
            }, ft_balance_raw: balance },
            pre_pre_tx_data: pre_pre_tx_data_from_parents(&parent, 0, std::slice::from_ref(&grandparent))
                .expect("FTLP ancestry"),
            pre_tx: parent,
            grandparents: vec![grandparent],
            pool: Some(fixture.consume.pool.clone()),
            fee_parent: Some(fixture.consume.fee_parent.clone()),
        }
    }).collect()
}

fn fee_from_output(tx: &Transaction, vout: usize, owner: &PrivateKey) -> Utxo {
    Utxo {
        outpoint: OutPoint { txid: tx.txid(), vout: vout as u32 },
        satoshis: tx.outputs[vout].satoshis,
        script_pubkey: tx.outputs[vout].script_pubkey.clone(),
        private_key: owner.clone(),
    }
}

fn pool_after(tx: &Transaction, previous: &PoolSpendContext) -> PoolSpendContext {
    PoolSpendContext {
        pool_utxo: UtxoInfo {
            outpoint: OutPoint { txid: tx.txid(), vout: 0 },
            satoshis: tx.outputs[0].satoshis,
            script_pubkey: tx.outputs[0].script_pubkey.clone(),
        },
        pool_pre_tx: tx.clone(),
        pool_pre_pre_tx: previous.pool_pre_tx.clone(),
        contract_tx: previous.contract_tx.clone(),
        state: PoolState::from_v2_tape(&tx.outputs[1].script_pubkey, PROVIDER.to_owned())
            .expect("maintenance Pool state"),
    }
}

fn merged_pool_ft(
    tx: &Transaction,
    inputs: &[FtSpendContext],
    input_grandparents: &[Vec<Transaction>],
    pool_parent: &Transaction,
    fee_parent: &Transaction,
    fee: &Utxo,
    owner: &PrivateKey,
) -> (FtSpendContext, Vec<Transaction>, Vec<Transaction>) {
    let finalized = Transaction::from_hex(&tx.to_hex()).expect("parse finalized Pool-FT maintenance");
    assert_eq!(finalized.txid(), tx.txid(), "Pool-FT maintenance finalized txid");
    let candidates = std::iter::once(pool_parent.clone())
        .chain(inputs.iter().map(|input| input.pre_tx.clone()))
        .chain(std::iter::once(fee_parent.clone()))
        .collect::<Vec<_>>();
    let mut parents = Vec::new();
    for input in &finalized.inputs {
        let matches = candidates.iter()
            .filter(|parent| parent.txid() == input.previous_output.txid)
            .collect::<Vec<_>>();
        assert!(!matches.is_empty(), "every Pool-FT maintenance input must resolve an authenticated raw parent");
        let parent = matches[0];
        assert!((input.previous_output.vout as usize) < parent.outputs.len(),
            "Pool-FT maintenance input vout must resolve in its raw parent");
        if !parents.iter().any(|existing: &Transaction| existing.txid() == parent.txid()) {
            parents.push(parent.clone());
        }
    }
    assert_eq!(parents.first().map(Transaction::txid), Some(pool_parent.txid()),
        "Pool raw parent must lead the authenticated parent order");
    let fee_input = finalized.inputs.last().expect("Pool-FT maintenance fee input");
    assert_eq!(fee_input.previous_output, fee.outpoint,
        "declared fee role must bind the exact consumed outpoint");
    assert_eq!(finalized.inputs.iter().filter(|input| input.previous_output == fee.outpoint).count(), 1,
        "declared fee outpoint must be consumed once");
    assert_eq!(fee_parent.txid(), fee.outpoint.txid, "fee raw parent txid binding");
    let fee_output = &fee_parent.outputs[fee.outpoint.vout as usize];
    assert_eq!((fee_output.satoshis, &fee_output.script_pubkey), (fee.satoshis, &fee.script_pubkey),
        "fee raw parent output must match expected value and script");
    assert_eq!(parents.iter().filter(|parent| parent.txid() == fee_parent.txid()).count(), 1,
        "shared Pool/fee predecessor raw bytes must occur once in the unique registry");
    let pool_input = &finalized.inputs[0].previous_output;
    assert_eq!(pool_input.txid, pool_parent.txid(), "Pool successor role parent txid");
    assert_ne!(*pool_input, fee.outpoint, "Pool and fee roles must consume distinct predecessor vouts");
    assert!((pool_input.vout as usize) < pool_parent.outputs.len(), "Pool successor vout must resolve");
    assert!(parents.iter().enumerate().all(|(index, parent)|
        parents[..index].iter().all(|earlier| earlier.txid() != parent.txid())),
        "Pool-FT maintenance raw parents must be unique in original input order");
    assert_eq!(input_grandparents.len(), inputs.len(), "one grandparent set per FT candidate");
    for (input, grandparents) in inputs.iter().zip(input_grandparents) {
        let source_slots = parsed_ft_slots(
            &input.pre_tx.outputs[input.utxo.base.outpoint.vout as usize + 1].script_pubkey,
        );
        let source_indexes = (0..6).rev().filter(|index| source_slots[*index] != 0).collect::<Vec<_>>();
        assert_eq!(source_indexes.len(), grandparents.len(),
            "candidate Tape source slots must match authenticated grandparents");
        for (source_index, grandparent) in source_indexes.into_iter().zip(grandparents) {
            let outpoint = &input.pre_tx.inputs[source_index].previous_output;
            assert_eq!(outpoint.txid, grandparent.txid(),
                "candidate pre-tx input must bind supplied grandparent txid");
            assert!((outpoint.vout as usize) < grandparent.outputs.len(),
                "candidate pre-tx input must bind supplied grandparent vout");
        }
    }
    let merged_slots = parsed_ft_slots(&finalized.outputs[3].script_pubkey);
    let source_indexes = (0..6).rev().filter(|index| merged_slots[*index] != 0).collect::<Vec<_>>();
    let ft_parents = source_indexes.into_iter().map(|source_index| {
        let outpoint = &finalized.inputs[source_index].previous_output;
        let matches = inputs.iter().filter(|input| input.utxo.base.outpoint == *outpoint).collect::<Vec<_>>();
        assert_eq!(matches.len(), 1,
            "merged FT Tape source slot must map one-to-one to candidate input outpoint");
        assert_eq!(matches[0].pre_tx.txid(), outpoint.txid,
            "merged FT ancestry parent bytes must authenticate candidate outpoint");
        matches[0].pre_tx.clone()
    }).collect::<Vec<_>>();
    assert_eq!(ft_parents.len(), inputs.len(), "FT ancestry subset cardinality");
    let spend = FtSpendContext {
        utxo: FtUtxo { base: Utxo {
            outpoint: OutPoint { txid: finalized.txid(), vout: 2 }, satoshis: finalized.outputs[2].satoshis,
            script_pubkey: finalized.outputs[2].script_pubkey.clone(), private_key: owner.clone(),
        }, ft_balance_raw: inputs.iter().map(|input| input.utxo.ft_balance_raw).sum() },
        pre_tx: finalized.clone(),
        pre_pre_tx_data: pre_pre_tx_data_from_parents(&finalized, 2, &ft_parents)
            .expect("merged Pool FT ancestry"),
    };
    (spend, ft_parents, parents)
}

fn merged_ftlp(
    tx: &Transaction,
    inputs: &[FtlpSpendContext],
    pool: &PoolSpendContext,
    fee: &Utxo,
) -> FtlpSpendContext {
    let parents = inputs.iter().rev().map(|input| input.pre_tx.clone()).collect::<Vec<_>>();
    let finalized = Transaction::from_hex(&tx.to_hex()).expect("parse finalized FTLP maintenance");
    assert_eq!(finalized.txid(), tx.txid(), "FTLP maintenance finalized txid");
    assert_eq!(finalized.inputs.len(), inputs.len() + 1, "FTLP inputs plus one fee input");
    for input in inputs {
        assert_eq!(finalized.inputs.iter().filter(|txin| txin.previous_output == input.utxo.base.outpoint).count(), 1,
            "each FTLP role must consume its exact outpoint once");
        assert_eq!(input.pre_tx.txid(), input.utxo.base.outpoint.txid,
            "each FTLP role must bind authenticated parent bytes");
    }
    assert_eq!(finalized.inputs.last().map(|input| &input.previous_output), Some(&fee.outpoint),
        "FTLP fee role must consume the declared fee-change vout");
    assert!(finalized.inputs.iter().enumerate().all(|(index, input)|
        finalized.inputs[..index].iter().all(|earlier| earlier.previous_output != input.previous_output)),
        "FTLP maintenance must not reuse a consumed outpoint");
    let mut raw_parents = inputs.iter().map(|input| input.pre_tx.clone()).collect::<Vec<_>>();
    let fee_parent = inputs[0].fee_parent.as_ref().expect("FTLP authenticated fee parent");
    assert_eq!(fee_parent.txid(), fee.outpoint.txid, "FTLP fee outpoint must bind its raw parent");
    if !raw_parents.iter().any(|parent| parent.txid() == fee_parent.txid()) {
        raw_parents.push(fee_parent.clone());
    }
    for input in &finalized.inputs {
        let matches = raw_parents.iter().filter(|parent| parent.txid() == input.previous_output.txid).count();
        assert_eq!(matches, 1, "each FTLP maintenance input must resolve exactly one authenticated parent");
        let parent = raw_parents.iter().find(|parent| parent.txid() == input.previous_output.txid).unwrap();
        assert!((input.previous_output.vout as usize) < parent.outputs.len(),
            "each FTLP maintenance outpoint must resolve in authenticated parent bytes");
    }
    FtlpSpendContext {
        utxo: tbc_sdk::FtlpUtxo { base: UtxoInfo {
            outpoint: OutPoint { txid: finalized.txid(), vout: 0 }, satoshis: finalized.outputs[0].satoshis,
            script_pubkey: finalized.outputs[0].script_pubkey.clone(),
        }, ft_balance_raw: inputs.iter().map(|input| input.utxo.ft_balance_raw).sum() },
        pre_tx: finalized.clone(),
        pre_pre_tx_data: pre_pre_tx_data_from_parents(&finalized, 0, &parents).expect("merged FTLP ancestry"),
        grandparents: parents,
        pool: Some(pool.clone()),
        fee_parent: Some(finalized),
    }
}

fn evidence_for(name: &str, operation: &str, transactions: &[Transaction]) -> Vec<Value> {
    let primary_index = transactions.len() - 1;
    let ids = (0..transactions.len()).map(|index| {
        if index == primary_index { format!("pool-{operation}") } else { format!("maintenance-{index}") }
    }).collect::<Vec<_>>();
    transactions.iter().enumerate().map(|(index, tx)| {
        let dependencies = transactions[..index].iter().enumerate()
            .filter(|(_, parent)| tx.inputs.iter().any(|input| input.previous_output.txid == parent.txid()))
            .map(|(parent, _)| ids[parent].as_str()).collect::<Vec<_>>();
        let mut value = tx_evidence(
            &ids[index], index, if index == primary_index { "primary" } else { "maintenance" },
            &dependencies, tx,
        );
        if index == primary_index {
            value["publicIntent"] = json!(match operation {
                "add" => "tbc.pool.liquidity.add",
                "remove" => "tbc.pool.liquidity.remove",
                "close" => "tbc.pool.liquidity.close",
                "swap-tbc-for-token" => "tbc.pool.swap.exactTbcForToken",
                "swap-token-for-tbc" => "tbc.pool.swap.exactTokenForTbc",
                _ => panic!("unknown Pool operation: {operation}"),
            });
        }
        value
    }).collect()
}

fn external_parent_manifest(transactions: &[Transaction], candidates: Vec<Transaction>) -> Value {
    let internal_txids = transactions.iter().map(Transaction::txid).collect::<Vec<_>>();
    let mut unique_candidates = Vec::<Transaction>::new();
    for candidate in candidates {
        if let Some(existing) = unique_candidates.iter().find(|existing| existing.txid() == candidate.txid()) {
            assert_eq!(existing.to_hex(), candidate.to_hex(),
                "duplicate external txid must have byte-identical raw transaction");
        } else {
            unique_candidates.push(candidate);
        }
    }
    let mut used = Vec::<Transaction>::new();
    for transaction in transactions {
        for input in &transaction.inputs {
            if internal_txids.contains(&input.previous_output.txid) {
                continue;
            }
            let matches = unique_candidates.iter()
                .filter(|candidate| candidate.txid() == input.previous_output.txid)
                .collect::<Vec<_>>();
            assert_eq!(matches.len(), 1,
                "every external input must resolve to exactly one Process A raw parent");
            let parent = matches[0];
            assert!((input.previous_output.vout as usize) < parent.outputs.len(),
                "Process A external input vout must resolve in authenticated raw parent");
            if !used.iter().any(|existing| existing.txid() == parent.txid()) {
                used.push(parent.clone());
            }
        }
    }
    json!({"externalParents": used.iter().map(|parent| json!({
        "txid": parent.txid().to_string(),
        "rawTransaction": parent.to_hex(),
    })).collect::<Vec<_>>()})
}

fn assert_declared_external_parents(spec: &Value, manifest: &Value) {
    if let Some(declared) = spec.get("externalParents") {
        assert_eq!(declared, &manifest["externalParents"],
            "Process A immutable external parent manifest must match exact-pin fixture bytes");
    }
}

fn six_decimal_raw(value: &str) -> u128 {
    let (whole, fraction) = value.split_once('.').expect("six-decimal fixture amount");
    assert!(!fraction.is_empty() && fraction.len() <= 6,
        "fixture amount must declare between one and six decimals");
    let scale = 10u128.pow(u32::try_from(6 - fraction.len()).unwrap());
    whole.parse::<u128>().expect("fixture whole amount") * 1_000_000
        + fraction.parse::<u128>().expect("fixture fractional amount") * scale
}

fn operation_scenario(spec: &Value) -> Value {
    let name = spec["name"].as_str().expect("source operation scenario");
    let operation = spec["operation"].as_str().expect("source Pool operation");
    let locked = spec["locked"].as_bool().unwrap_or(false);
    let fixture = operation_fixture(locked);
    let pool_ft_count = spec["poolFtFragments"].as_u64().unwrap_or(1) as usize;
    let ftlp_count = spec["ftlpFragments"].as_u64().unwrap_or(1) as usize;
    let ftlp_amounts = spec.get("ftlpAmounts")
        .and_then(Value::as_array)
        .map(|amounts| amounts.iter().map(|amount| amount.as_u64().expect("FTLP amount")).collect::<Vec<_>>());
    if let Some(amounts) = &ftlp_amounts {
        assert_eq!(amounts.len(), ftlp_count,
            "declared FTLP candidate count must match independently declared amounts");
    }
    let pool_ft_amounts = spec.get("poolFtAmounts")
        .and_then(Value::as_array)
        .map(|amounts| amounts.iter().map(|amount| amount.as_u64().expect("Pool-FT amount")).collect::<Vec<_>>())
        .unwrap_or_else(|| (0..pool_ft_count).map(|index| 900_000 + index as u64 * 10_000).collect());
    assert_eq!(pool_ft_amounts.len(), pool_ft_count,
        "declared Pool-FT candidate count must match independently declared amounts");
    let (mut ft_inputs, mut ft_grandparents) = if pool_ft_count == 1 {
        (fixture.consume.ft_inputs.clone(), fixture.consume.ft_grandparents.clone())
    } else {
        distinct_pool_ft_inputs(&fixture, &pool_ft_amounts)
    };
    let mut ftlp_inputs = if let Some(amounts) = &ftlp_amounts {
        distinct_ftlp_inputs(&fixture, amounts)
    } else if ftlp_count == 1 {
        fixture.consume.ftlp_inputs.clone()
    } else {
        let amounts = (0..ftlp_count).map(|index| 2_000 + index as u64 * 100).collect::<Vec<_>>();
        distinct_ftlp_inputs(&fixture, &amounts)
    };
    let mut external_candidates = vec![
        fixture.consume.pool.pool_pre_tx.clone(),
        fixture.consume.fee_parent.clone(),
    ];
    external_candidates.extend(ft_inputs.iter().map(|input| input.pre_tx.clone()));
    external_candidates.extend(ftlp_inputs.iter().map(|input| input.pre_tx.clone()));
    let mut maintenance = Vec::new();
    let mut pool_context = fixture.consume.pool.clone();
    let mut fee = fixture.fee.clone();
    let mut fee_parent = fixture.consume.fee_parent.clone();

    if !locked {
        let needed_lp = six_decimal_raw(spec["lpHuman"].as_str().unwrap_or("0.001"));
        if let Some(index) = ftlp_inputs.iter().position(|input| input.utxo.ft_balance_raw >= needed_lp) {
            ftlp_inputs = vec![ftlp_inputs.remove(index)];
        } else {
            let total = ftlp_inputs.iter().try_fold(0u128, |sum, input| {
                sum.checked_add(input.utxo.ft_balance_raw)
            }).expect("checked FTLP candidate total");
            assert!(total >= needed_lp, "insufficient FTLP balance must fail before maintenance");
        let mut consumed_outpoints = Vec::new();
        while !ftlp_inputs.iter().any(|input| input.utxo.ft_balance_raw >= needed_lp) {
            let mut selected_total = 0u128;
            let mut selected_count = 0usize;
            for input in ftlp_inputs.iter().take(5) {
                selected_total = selected_total.checked_add(input.utxo.ft_balance_raw)
                    .expect("checked FTLP maintenance prefix");
                selected_count += 1;
                if selected_total >= needed_lp {
                    break;
                }
            }
            let selected = ftlp_inputs.iter().take(selected_count).cloned().collect::<Vec<_>>();
            assert!(selected.len() >= 2, "necessary FTLP maintenance requires at least two candidates");
            let consumed_fee = fee.clone();
            let tx = fixture.pool.merge_ftlp(&fixture.owner, fee.clone(), selected.clone(), None)
                .expect("released FTLP merge").expect("mergeable FTLP set");
            for input in &tx.inputs {
                assert!(!consumed_outpoints.contains(&input.previous_output),
                    "FTLP maintenance rounds must not reuse an outpoint");
                consumed_outpoints.push(input.previous_output.clone());
            }
            let merged = merged_ftlp(&tx, &selected, &pool_context, &consumed_fee);
            fee = fee_from_output(&tx, 2, &fixture.owner);
            fee_parent = tx.clone();
            ftlp_inputs.drain(..selected.len());
            ftlp_inputs.insert(0, merged);
            for input in &mut ftlp_inputs {
                input.pool = Some(pool_context.clone());
                input.fee_parent = Some(tx.clone());
            }
            maintenance.push(tx);
        }
        let sufficient = ftlp_inputs.iter()
            .position(|input| input.utxo.ft_balance_raw >= needed_lp)
            .expect("FTLP maintenance successor must satisfy the requested amount");
        ftlp_inputs = vec![ftlp_inputs.remove(sufficient)];
        }
    }

    let pool_ft_direct_limit = match operation {
        "remove" | "close" => Some(3usize),
        "swap-tbc-for-token" => Some(4usize),
        "add" | "swap-token-for-tbc" => None,
        _ => panic!("unknown Pool operation: {operation}"),
    };
    assert_eq!(ft_inputs.len(), ft_grandparents.len(),
        "every selected Pool-FT input must retain its authenticated ancestry");
    for (input, grandparents) in ft_inputs.iter().zip(&ft_grandparents) {
        assert_eq!(input.utxo.base.outpoint.txid, input.pre_tx.txid(),
            "every supplied Pool-FT outpoint must resolve to its authenticated parent");
        assert!((input.utxo.base.outpoint.vout as usize) < input.pre_tx.outputs.len(),
            "every supplied Pool-FT vout must resolve before selection");
        assert!(!grandparents.is_empty(),
            "every supplied Pool-FT candidate must retain authenticated ancestry");
    }
    let mut paired = ft_inputs.into_iter().zip(ft_grandparents).collect::<Vec<_>>();
    paired.sort_by(|(left, _), (right, _)| {
        right.utxo.ft_balance_raw.cmp(&left.utxo.ft_balance_raw)
            .then_with(|| left.utxo.base.outpoint.txid.as_le_bytes()
                .cmp(right.utxo.base.outpoint.txid.as_le_bytes()))
            .then_with(|| left.utxo.base.outpoint.vout.cmp(&right.utxo.base.outpoint.vout))
    });
    (ft_inputs, ft_grandparents) = paired.into_iter().unzip();
    let required_pool_ft_raw = spec.get("requiredPoolFtRaw")
        .and_then(Value::as_u64)
        .map(u128::from);
    if let Some(direct_limit) = pool_ft_direct_limit {
        if ft_inputs.len() > direct_limit {
            let needed = required_pool_ft_raw.expect(
                "fragmented Pool-FT scenario must independently declare requiredPoolFtRaw",
            );
            let mut direct_total = 0u128;
            let mut direct_count = None;
            for (index, input) in ft_inputs.iter().take(direct_limit).enumerate() {
                direct_total = direct_total.checked_add(input.utxo.ft_balance_raw)
                    .expect("checked Pool-FT direct total");
                if direct_total >= needed {
                    direct_count = Some(index + 1);
                    break;
                }
            }
            if let Some(count) = direct_count {
                ft_inputs.truncate(count);
                ft_grandparents.truncate(count);
            } else {
                let total = ft_inputs.iter().try_fold(0u128, |sum, input| {
                    sum.checked_add(input.utxo.ft_balance_raw)
                }).expect("checked Pool-FT candidate total");
                assert!(total >= needed,
                    "insufficient Pool-FT balance must fail before maintenance");
                let mut frontier = ft_inputs.into_iter().zip(ft_grandparents).collect::<Vec<_>>();
                loop {
                    let mut direct_total = 0u128;
                    let mut direct_count = None;
                    for (index, (input, _)) in frontier.iter().take(direct_limit).enumerate() {
                        direct_total = direct_total.checked_add(input.utxo.ft_balance_raw)
                            .expect("checked post-maintenance Pool-FT prefix");
                        if direct_total >= needed {
                            direct_count = Some(index + 1);
                            break;
                        }
                    }
                    if let Some(count) = direct_count {
                        (ft_inputs, ft_grandparents) = frontier.drain(..count).unzip();
                        break;
                    }
                    let merge_count = frontier.len().min(4);
                    assert!(merge_count >= 2,
                        "Pool-FT maintenance must merge at least two candidates");
                    let selected = frontier.drain(..merge_count).collect::<Vec<_>>();
                    let (selected_inputs, selected_grandparents): (Vec<_>, Vec<_>) =
                        selected.into_iter().unzip();
                    let mut merge_context = fixture.consume.clone();
                    merge_context.pool = pool_context.clone();
                    merge_context.ft_inputs = selected_inputs.clone();
                    merge_context.ft_grandparents = selected_grandparents.clone();
                    merge_context.ftlp_inputs.clear();
                    merge_context.ftlp_grandparents.clear();
                    merge_context.fee_parent = fee_parent.clone();
                    let mut merged = fixture.pool
                        .merge_ft_in_pool(merge_context, &fixture.owner, fee.clone(), 1)
                        .expect("released Pool FT merge");
                    assert_eq!(merged.len(), 1, "one explicit released merge call must produce one round");
                    let tx = merged.remove(0);
                    let (merged_input, ft_parents, raw_parents) = merged_pool_ft(
                        &tx,
                        &selected_inputs,
                        &selected_grandparents,
                        &pool_context.pool_pre_tx,
                        &fee_parent,
                        &fee,
                        &fixture.owner,
                    );
                    for input in &tx.inputs {
                        let matches = raw_parents
                            .iter()
                            .filter(|parent| parent.txid() == input.previous_output.txid)
                            .collect::<Vec<_>>();
                        assert_eq!(matches.len(), 1,
                            "every Pool-FT maintenance input must resolve to one authenticated raw parent");
                        assert!((input.previous_output.vout as usize) < matches[0].outputs.len(),
                            "every Pool-FT maintenance input vout must resolve in its authenticated raw parent");
                    }
                    pool_context = pool_after(&tx, &pool_context);
                    fee = fee_from_output(&tx, 4, &fixture.owner);
                    fee_parent = tx.clone();
                    assert_eq!(fee.outpoint, OutPoint { txid: tx.txid(), vout: 4 },
                        "next Pool-FT round must spend finalized predecessor fee change");
                    maintenance.push(tx);
                    frontier.insert(0, (merged_input, ft_parents));
                }
            }
        }
    }

    let mut context = fixture.consume.clone();
    context.pool = pool_context;
    context.ft_inputs = ft_inputs;
    context.ft_grandparents = ft_grandparents;
    context.ftlp_inputs = ftlp_inputs;
    context.ftlp_grandparents = context.ftlp_inputs.iter().map(|input| input.grandparents.clone()).collect();
    context.fee_parent = fee_parent;
    let live_lp_raw = context.pool.state.amounts.ft_lp_raw;
    let input_lp_raw = context.ftlp_inputs.iter().map(|input| input.utxo.ft_balance_raw).sum::<u128>();
    if operation == "close" {
        assert_eq!(input_lp_raw, u128::from(live_lp_raw),
            "close FTLP inputs must equal authenticated live Pool LP total");
    }
    let close_human = format!("{}.{:06}", live_lp_raw / 1_000_000, live_lp_raw % 1_000_000);
    let mut primary = match operation {
        "add" => vec![fixture.pool.increase_lp(
            fixture.increase.clone(), &fixture.owner, fixture.fee.clone(), "0.001",
            if locked { 800_200 } else { 0 },
        ).expect("released Pool add")],
        "remove" => fixture.pool.consume_lp(
            context, &fixture.owner, fee,
            spec["lpHuman"].as_str().unwrap_or("0.001"), locked.then_some(800_101),
        ).expect("released Pool remove"),
        "close" => fixture.pool.consume_lp(
            context, &fixture.owner, fee, &close_human, locked.then_some(800_101),
        ).expect("released Pool close"),
        "swap-tbc-for-token" => {
            context.ftlp_inputs.clear();
            context.ftlp_grandparents.clear();
            vec![fixture.pool.swap_to_token(context, &fixture.owner, fee, "0.001", 1)
                .expect("released TBC-to-token swap")]
        }
        "swap-token-for-tbc" => {
            let mut swap = fixture.increase.clone();
            swap.fee_parent = fixture.increase.fee_parent.clone();
            vec![fixture.pool.swap_to_tbc(swap, &fixture.owner, fixture.fee.clone(), "0.1", 1)
                .expect("released token-to-TBC swap")]
        }
        _ => panic!("unknown Pool operation: {operation}"),
    };
    maintenance.append(&mut primary);
    let input_manifest = external_parent_manifest(&maintenance, external_candidates);
    assert_declared_external_parents(spec, &input_manifest);
    let (rate, address) = released_plan(1);
    json!({
        "name": name,
        "releasedPlan": {"lpPlan":1,"serviceFeeRate":rate,"serviceFeeAddress":address},
        "inputManifest": input_manifest,
        "transactions": evidence_for(name, operation, &maintenance),
    })
}

fn create_scenario(spec: &Value) -> Value {
    if spec["operation"].is_string() {
        return operation_scenario(spec);
    }
    let name = spec["name"].as_str().expect("source scenario name");
    let lp_plan = spec["lpPlan"].as_u64().expect("source LP plan") as u8;
    let locked = spec["locked"].as_bool().unwrap_or(false);
    let (rate, address) = released_plan(lp_plan);
    assert_eq!(spec["serviceFeeRate"], json!(rate));
    let fixture = create_fixture(lp_plan, locked);
    let _isolation = (&fixture.owner, &fixture.authority, &fixture.pool_source);
    let mut initialized = tx_evidence(
        "pool-init",
        1,
        "primary",
        &["pool-mint"],
        &fixture.initialized,
    );
    initialized["publicIntent"] = json!("tbc.pool.create");
    let transactions = vec![fixture.pool_contract.clone(), fixture.initialized.clone()];
    let input_manifest = external_parent_manifest(
        &transactions,
        vec![fixture.pool_source.clone(), fixture.owner_ft.clone(), fixture.fee_parent.clone()],
    );
    assert_declared_external_parents(spec, &input_manifest);
    json!({
        "name": name,
        "releasedPlan": {"lpPlan":lp_plan,"serviceFeeRate":rate,"serviceFeeAddress":address},
        "inputManifest": input_manifest,
        "transactions": [
            tx_evidence("pool-mint", 0, "prerequisite", &[], &fixture.pool_contract),
            initialized,
        ],
    })
}

fn main() {
    let input_path = env::args().nth(1).expect("source input path");
    let output_path = env::args().nth(2).expect("source output path");
    let input_bytes = fs::read(&input_path).expect("read immutable Process A input");
    let input: Value = serde_json::from_slice(&input_bytes).expect("Process A input JSON");
    assert_eq!(input["schemaVersion"], 1);
    let scenarios = input["scenarios"]
        .as_array()
        .expect("Process A scenarios")
        .iter()
        .map(create_scenario)
        .collect::<Vec<_>>();
    let output = json!({
        "schemaVersion":1,
        "pin":PIN,
        "producer":"pinned-source",
        "sourceSdkInvoked":true,
        "inputSha256":encode_hex(&Sha256::digest(&input_bytes)),
        "scenarios":scenarios,
    });
    fs::write(output_path, format!("{}\n", serde_json::to_string_pretty(&output).unwrap()))
        .expect("write immutable Process A output");
}

#[cfg(test)]
mod scenario_tests;
