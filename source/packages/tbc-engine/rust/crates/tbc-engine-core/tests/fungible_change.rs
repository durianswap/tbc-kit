use serde_json::Value;
use tbc_engine_core::protocols::fungible_change::{
    FungiblePair, FungibleProtocol, fungible_changes, inspect_fungible_pair,
};
use tbc_sdk::{Address, OutPoint, Transaction, TxOut, script::Script,
    contracts::{ft::scripts as ft, stable_coin::scripts as coin}};

fn owner() -> Address { Address::from_string("1BgGZ9tcN4rm9KBzDn7KprQz87SZ26SAMH").unwrap() }
fn outpoint(n: u32) -> OutPoint { OutPoint { txid: "11".repeat(32).parse().unwrap(), vout: n } }
fn amounts(amount: u64) -> [u8; 48] {
    let mut bytes = [0; 48]; bytes[..8].copy_from_slice(&amount.to_le_bytes()); bytes
}
fn outputs(stable: bool, v3: bool, amount: u64, origin: u8, other_owner: bool) -> [TxOut; 2] {
    let tape = if stable {
        coin::coin_tape_script(&amounts(amount), 6, "Token", "TOK", 500000001)
    } else { ft::mint_tape_script(&amounts(amount), 6, "Token", "TOK") };
    let recipient = if other_owner { Address::from_string("1cMh228HTCiwS8ZsaakH8A8wze1JR5ZsP").unwrap() } else { owner() };
    let code = if stable {
        coin::coin_mint_code_script_with_version(&[4; 20], &recipient, &[origin; 32],
            tape.as_bytes().len(), if v3 { coin::StableCoinMintVersion::V3 } else { coin::StableCoinMintVersion::V4 }).unwrap()
    } else {
        ft::mint_code_script_with_version(&format!("{origin:02x}").repeat(32), 0, &recipient,
            tape.as_bytes().len(), if v3 { ft::FtMintVersion::V3 } else { ft::FtMintVersion::V4 }).unwrap()
    };
    [TxOut { satoshis: 500, script_pubkey: code }, TxOut { satoshis: 0, script_pubkey: tape }]
}
fn pair(outputs: &[TxOut]) -> FungiblePair { inspect_fungible_pair(&outputs[0], outputs.get(1)).unwrap().unwrap() }

#[test]
fn historical_ft_and_stablecoin_transfer_merge_burn_are_not_issuance() {
    for stable in [false, true] { for v3 in [false, true] {
        let original = pair(&outputs(stable, v3, 1000, 1, false));
        assert_eq!(original.identity.protocol, if stable {
            FungibleProtocol::HistoricalStableCoin(if v3 { 3 } else { 4 })
        } else { FungibleProtocol::HistoricalFt(if v3 { 3 } else { 4 }) });
        let sent = pair(&outputs(stable, v3, 400, 1, true));
        let change = pair(&outputs(stable, v3, 600, 1, false));
        assert_eq!(original.identity, sent.identity);
        let transfer = fungible_changes(&[(outpoint(0), original.clone())], &[(0, sent.clone()), (2, change.clone())]).unwrap();
        assert_eq!(transfer.len(), 1);
        assert!(!transfer[0].is_historical_issuance());
        let merged = fungible_changes(&[(outpoint(0), sent), (outpoint(2), change)], &[(0, original.clone())]).unwrap();
        assert!(!merged[0].is_historical_issuance());
        let burned = fungible_changes(&[(outpoint(0), original)], &[]).unwrap();
        assert!(!burned[0].is_historical_issuance());
    }}
}

#[test]
fn creation_inflation_and_different_asset_cannot_look_like_transfer() {
    for stable in [false, true] {
        let zero = pair(&outputs(stable, false, 0, 1, false));
        assert!(fungible_changes(&[], &[(0, zero)]).unwrap()[0].is_historical_issuance());
        let original = pair(&outputs(stable, false, 1000, 1, false));
        let inflated = pair(&outputs(stable, false, 1001, 1, false));
        assert!(fungible_changes(&[(outpoint(0), original.clone())], &[(0, inflated)]).unwrap()[0].is_historical_issuance());
        let different = pair(&outputs(stable, false, 1000, 2, false));
        let changes = fungible_changes(&[(outpoint(0), original)], &[(0, different)]).unwrap();
        assert_eq!(changes.len(), 2);
        assert_eq!(changes.iter().filter(|c| c.is_historical_issuance()).count(), 1);
    }
}

#[test]
fn malformed_tape_and_value_rejected_unknown_script_never_classified_as_safe() {
    let original = outputs(false, false, 1000, 1, false);
    assert!(inspect_fungible_pair(&original[0], None).is_err());
    let mut bad = original.clone(); bad[0].satoshis = 499;
    assert!(inspect_fungible_pair(&bad[0], Some(&bad[1])).is_err());
    let mut bad = original.clone(); bad[1].satoshis = 1;
    assert!(inspect_fungible_pair(&bad[0], Some(&bad[1])).is_err());
    let mut bad = original.clone();
    let mut bytes = bad[1].script_pubkey.as_bytes().to_vec(); bytes[10] |= 0x80;
    bad[1].script_pubkey = Script::from_bytes(bytes);
    assert!(inspect_fungible_pair(&bad[0], Some(&bad[1])).is_err());
    let mut unknown = original.clone();
    let mut bytes = unknown[0].script_pubkey.as_bytes().to_vec(); bytes[40] ^= 1;
    unknown[0].script_pubkey = Script::from_bytes(bytes);
    assert!(inspect_fungible_pair(&unknown[0], Some(&unknown[1])).unwrap().is_none());
    let native = TxOut { satoshis: 500, script_pubkey: Script::p2pkh(&owner().hash160()) };
    assert!(inspect_fungible_pair(&native, None).unwrap().is_none());
}

#[test]
fn duplicate_material_and_sum_overflow_cannot_credit_extra_balance() {
    let original = pair(&outputs(false, false, 1000, 1, false));
    assert!(fungible_changes(&[(outpoint(0), original.clone()), (outpoint(0), original.clone())], &[]).is_err());
    assert!(fungible_changes(&[], &[(0, original.clone()), (0, original.clone())]).is_err());
    let mut large = original.clone(); large.amount = u128::MAX;
    assert!(fungible_changes(&[(outpoint(0), large.clone()), (outpoint(1), original.clone())], &[]).is_err());
    assert!(fungible_changes(&[], &[(0, large), (2, original)]).is_err());
}

#[test]
fn real_new_standard_fixture_is_separate_from_historical_issuance_policy() {
    let fixture: Value = serde_json::from_str(include_str!("../../../fixtures/tbc20-standard-transfer.json")).unwrap();
    let genesis = Transaction::from_hex(fixture["stages"][1]["signedRaw"].as_str().unwrap()).unwrap();
    let transfer = Transaction::from_hex(fixture["stages"][2]["signedRaw"].as_str().unwrap()).unwrap();
    let minted = pair(&genesis.outputs);
    assert_eq!(minted.identity.protocol, FungibleProtocol::Tbc20Standard);
    assert!(!fungible_changes(&[], &[(0, minted.clone())]).unwrap()[0].is_historical_issuance());
    let sent = pair(&transfer.outputs);
    let change = pair(&transfer.outputs[2..]);
    let changes = fungible_changes(&[(OutPoint {txid: genesis.txid(), vout: 0}, minted)], &[(0, sent), (2, change)]).unwrap();
    assert_eq!(changes.len(), 1);
    assert_eq!(changes[0].input_amount, changes[0].output_amount);
    assert!(!changes[0].is_historical_issuance());
}

#[test]
fn previous_tbc20_template_is_historical_even_with_the_same_family_label() {
    use tbc_sdk::contracts::tbc20 as old;
    let origin = old::Tbc20Outpoint {txid: outpoint(0).txid, output_index: 0};
    let mut controller = [0; 21]; controller[..20].copy_from_slice(&owner().hash160());
    let code = old::instantiate_tbc20_code(&origin, controller, 61).unwrap();
    let tape = old::build_tbc20_tape([100, 0, 0, 0, 0, 0], 61, &[9]).unwrap();
    let old_pair = pair(&[TxOut {satoshis: 500, script_pubkey: code}, TxOut {satoshis: 0, script_pubkey: tape}]);
    assert_eq!(old_pair.identity.protocol, FungibleProtocol::HistoricalTbc20);
    assert!(fungible_changes(&[], &[(0, old_pair.clone())]).unwrap()[0].is_historical_issuance());
    assert!(!fungible_changes(&[(outpoint(0), old_pair.clone())], &[(0, old_pair)]).unwrap()[0].is_historical_issuance());
}

#[test]
fn stablecoin_lock_time_change_is_not_new_supply_or_a_new_identity() {
    let input = outputs(true, false, 1000, 1, false);
    let mut output = input.clone();
    output[1].script_pubkey = coin::coin_tape_script(&amounts(1000), 6, "Token", "TOK", 500000002);
    let changes = fungible_changes(&[(outpoint(0), pair(&input))], &[(0, pair(&output))]).unwrap();
    assert_eq!(changes.len(), 1);
    assert!(!changes[0].is_historical_issuance());
    // Whether this particular lock time is authorized remains the existing
    // StableCoin validation's job; supply classification must not replace it.
}

#[test]
fn original_validator_still_reports_stablecoin_as_contract_not_ft_pair() {
    use tbc_sdk::{InMemoryTokenTransactionFetcher, TokenValidationOptions,
        validate_on_chain_transaction_with_fetcher};
    let fixture: Value = serde_json::from_str(include_str!("../../../fixtures/tbc20-standard-transfer.json")).unwrap();
    let mut transaction = Transaction::from_hex(fixture["stages"][1]["signedRaw"].as_str().unwrap()).unwrap();
    transaction.outputs = outputs(true, false, 1000, 1, false).to_vec();
    assert_eq!(pair(&transaction.outputs).identity.protocol, FungibleProtocol::HistoricalStableCoin(4));
    let empty = InMemoryTokenTransactionFetcher::default();
    let report = validate_on_chain_transaction_with_fetcher(TokenValidationOptions {
        transaction: Some(transaction), fetcher: Some(&empty), ..TokenValidationOptions::default()
    });
    assert!(report.output_groups.iter().all(|group| group.protocol.is_none()));
    let code_group = &report.output_groups[0];
    assert_eq!(code_group.kind, "CONTRACT");
    assert_eq!(code_group.recognized_contract.as_ref().unwrap().family, "STABLE_COIN");
    assert_eq!(code_group.recognized_contract.as_ref().unwrap().version, 4);
}

#[test]
fn six_real_tape_slots_preserve_supply_above_u64() {
    for stable in [false, true] {
        let mut material = outputs(stable, false, 1000, 1, false);
        let mut bytes = material[1].script_pubkey.as_bytes().to_vec();
        for slot in bytes[3..51].chunks_exact_mut(8) {
            slot.copy_from_slice(&(i64::MAX as u64).to_le_bytes());
        }
        material[1].script_pubkey = Script::from_bytes(bytes);
        let decoded = pair(&material);
        assert_eq!(decoded.amount, 6 * i64::MAX as u128);
        assert!(decoded.amount > u64::MAX as u128);
        let changes = fungible_changes(&[(outpoint(0), decoded.clone())], &[(0, decoded)]).unwrap();
        assert!(!changes[0].is_historical_issuance());
    }
}
