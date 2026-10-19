//! One wire adapter for initial tasks and approval-bound continuations.
//! No signer, key derivation, implicit account selection, or network operations.
use crate::{EngineError, ErrorCode};
use crate::model::{AccountIdentity, CanonicalRequest, SnapshotPayload, ResolvedSigningRole, TransactionSigningTask, error};
use crate::signing::{SigningRequest, SigningStage, UnsignedPlan};

pub(crate) fn validate_requested_roles(request: &CanonicalRequest) -> Result<(), EngineError> {
    let Some(roles) = &request.signing_roles else { return Ok(()); };
    // Only implemented role/intent combinations may enter the public wire.
    // Other protocol roles extend this shared model when their builders land.
    if roles.len() != 1 || !matches!((roles[0].role.as_str(), request.intent.intent_type.as_str()),
        ("pool-controller", "tbc-amm-add-liquidity" | "tbc-amm-remove-liquidity" | "tbc-amm-swap" | "amm.swap" | "amm.addLiquidity" | "amm.removeLiquidity") |
        ("coin-admin", "tbc20-stablecoin-create" | "tbc20-stablecoin-mint" | "tbc20-stablecoin-freeze" | "tbc20-stablecoin-unfreeze")) {
        return Err(error(ErrorCode::InvalidInput, "unsupported or duplicate transaction signing role", "request.signingRoles"));
    }
    let prefix = format!("{}:", request.chain_id);
    let address = roles[0].account_id.strip_prefix(&prefix)
        .ok_or_else(|| error(ErrorCode::InvalidInput, "signing role account belongs to another chain", "request.signingRoles"))?;
    tbc_sdk::Address::from_string(address).map_err(|_| error(ErrorCode::InvalidInput, "signing role account address is invalid", "request.signingRoles"))?;
    Ok(())
}

/// Keyless account binding only. Host must separately authorize these exact
/// accounts; neither DApp role hints nor a chain snapshot grant permission.
pub(crate) struct SigningAccounts<'a> {
    primary: &'a AccountIdentity,
    additional_role: Option<(&'a AccountIdentity, &'static str)>,
}
impl<'a> SigningAccounts<'a> {
    pub(crate) fn resolve(request: &CanonicalRequest, snapshot: &'a SnapshotPayload) -> Result<Self, EngineError> {
        validate_requested_roles(request)?;
        let primary = &snapshot.account;
        let additional = snapshot.signing_accounts.as_deref().unwrap_or(&[]);
        let role = request.signing_roles.as_ref().and_then(|roles| roles.first());
        let requested_extra = role.filter(|role| role.account_id != primary.account_id);
        if additional.len() != usize::from(requested_extra.is_some()) ||
            snapshot.signing_accounts.as_ref().is_some_and(Vec::is_empty) {
            return Err(error(ErrorCode::InvalidSignature, "snapshot signing accounts must exactly match requested roles", "snapshot.payload.signingAccounts"));
        }
        if role.is_none() { return Ok(Self { primary, additional_role: None }); }
        let controller = if let Some(role) = requested_extra {
            if additional[0].account_id != role.account_id { return Err(error(ErrorCode::InvalidSignature, "requested signing account is missing", "snapshot.payload.signingAccounts")); }
            &additional[0]
        } else { primary };
        for account in [primary, controller] {
            if account.chain_id != request.chain_id || account.account_id != format!("{}:{}", account.chain_id, account.address) || !account_key_matches(account, &account.public_key) {
                return Err(error(ErrorCode::InvalidSignature, "signing account identity is invalid", "snapshot.payload.signingAccounts"));
            }
            let key = tbc_sdk::PublicKey::from_slice(&super::families::ft::decode_hex(&account.public_key, "snapshot.payload.signingAccounts.publicKey")?)
                .map_err(|_| error(ErrorCode::InvalidSignature, "signing account key invalid", "snapshot.payload.signingAccounts"))?;
            let address = tbc_sdk::Address::from_string(&account.address)
                .map_err(|_| error(ErrorCode::InvalidSignature, "signing account address invalid", "snapshot.payload.signingAccounts"))?;
            if address.hash160() != key.hash160() { return Err(error(ErrorCode::InvalidSignature, "signing account key and address differ", "snapshot.payload.signingAccounts")); }
        }
        if controller.account_id != primary.account_id && controller.public_key[2..] == primary.public_key[2..] {
            return Err(error(ErrorCode::InvalidSignature, "ambiguous signing key assigned to multiple accounts", "snapshot.payload.signingAccounts"));
        }
        let name = if role.unwrap().role == "coin-admin" { "coin-admin" } else { "pool-controller" };
        Ok(Self { primary, additional_role: Some((controller, name)) })
    }
    pub(crate) fn controller(&self) -> Option<&'a AccountIdentity> {
        self.additional_role.filter(|(_, role)| *role == "pool-controller").map(|(account, _)| account)
    }
    pub(crate) fn coin_administrator(&self) -> &'a AccountIdentity {
        self.additional_role.filter(|(_, role)| *role == "coin-admin").map(|(account, _)| account).unwrap_or(self.primary)
    }
    fn account_for(&self, key: &str) -> Result<&'a AccountIdentity, EngineError> {
        if account_key_matches(self.primary, key) { return Ok(self.primary); }
        self.additional_role.map(|(account, _)| account).filter(|account| account_key_matches(account, key))
            .ok_or_else(|| error(ErrorCode::InvalidSignature, "plan signing key has no bound role account", "snapshot.payload.signingAccounts"))
    }
    pub(crate) fn authorize_plan(&self, plan: &UnsignedPlan) -> Result<(), EngineError> {
        if self.additional_role.is_none() { return authorize_plan_account(plan, self.primary); }
        for input in plan.transactions.iter().flat_map(|tx| &tx.inputs) { self.account_for(&input.signer.public_key)?; }
        Ok(())
    }
    pub(crate) fn tasks(&self, stage: &SigningStage) -> Result<Vec<TransactionSigningTask>, EngineError> {
        if self.additional_role.is_none() { return public_signing_tasks(stage, self.primary); }
        stage.signing_requests.iter().map(|request| task_for(request, self.account_for(&request.public_key)?)).collect()
    }
    pub(crate) fn preview(&self) -> Option<Vec<ResolvedSigningRole>> {
        self.additional_role.map(|(account, role)| vec![ResolvedSigningRole { role: role.into(), account: account.clone() }])
    }
}

// Each account envelope binds one compressed SEC key.
// Its BIP340 encoding is the same point's x coordinate, not another account.
// Pure builders may compose independent keys; the public wallet boundary must
// not silently assign those keys to the fee payer's account ID.
fn account_key_matches(account: &AccountIdentity, key: &str) -> bool {
    let sec = account.public_key.as_bytes();
    sec.len() == 66 && (sec.starts_with(b"02") || sec.starts_with(b"03"))
        && sec.iter().all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(b))
        && (key == account.public_key || key.as_bytes() == &sec[2..])
}

pub(crate) fn authorize_plan_account(plan: &UnsignedPlan, account: &AccountIdentity) -> Result<(), EngineError> {
    // Includes deferred stages: never show approval for a source transaction
    // that will later require an unbound administrator's signature.
    if plan.transactions.iter().flat_map(|tx| &tx.inputs)
        .any(|input| !account_key_matches(account, &input.signer.public_key)) {
        return Err(error(ErrorCode::InvalidSignature, "plan signing key is not authorized by the bound account", "snapshot.payload.account"));
    }
    Ok(())
}

pub(crate) fn task_id(request: &SigningRequest) -> String {
    format!("sign-{}-input-{}", request.transaction_id, request.input_index)
}

pub(crate) fn signing_profile(request: &SigningRequest) -> Result<(&'static str, &'static str), EngineError> {
    let key = request.public_key.as_bytes();
    if request.sighash_type != 65 || !key.iter().all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(b)) {
        return Err(error(ErrorCode::InvalidSignature, "invalid transaction signing profile", "signatures"));
    }
    match request.algorithm.as_str() {
        "secp256k1-ecdsa" if key.len() == 66 && (key.starts_with(b"02") || key.starts_with(b"03")) =>
            Ok(("secp256k1-ecdsa-sha256d", "compact64")),
        "secp256k1-schnorr" if key.len() == 64 =>
            Ok(("secp256k1-schnorr-bip340", "schnorr64")),
        _ => Err(error(ErrorCode::InvalidSignature, "algorithm and public key encoding differ", "signatures")),
    }
}

pub(crate) fn public_signing_tasks(stage: &SigningStage, account: &AccountIdentity) -> Result<Vec<TransactionSigningTask>, EngineError> {
    stage.signing_requests.iter().map(|request| task_for(request, account)).collect()
}
fn task_for(request: &SigningRequest, account: &AccountIdentity) -> Result<TransactionSigningTask, EngineError> {
    let (algorithm, encoding) = signing_profile(request)?;
    if !account_key_matches(account, &request.public_key) {
        return Err(error(ErrorCode::InvalidSignature, "signing task key is not authorized by the bound account", "snapshot.payload.account"));
    }
    Ok(TransactionSigningTask {
        task_id: task_id(request), purpose: "transaction".into(),
        algorithm: algorithm.into(), digest: request.digest.clone(),
        signature_encoding: encoding.into(),
        transaction_template_id: request.transaction_id.clone(), input_index: request.input_index,
        account_id: account.account_id.clone(), public_key: request.public_key.clone(), sighash_type: request.sighash_type,
    })
}

#[cfg(test)]
pub(crate) mod tests {
    use super::*;
    use crate::signing::SigningContinuation;

    pub fn request(schnorr: bool) -> SigningRequest {
        SigningRequest {
            session_id: "session".into(), stage: 0, stage_commitment: "00".repeat(32),
            transaction_id: "tx-1".into(), input_index: 0,
            algorithm: if schnorr { "secp256k1-schnorr" } else { "secp256k1-ecdsa" }.into(),
            sighash_type: 65, digest: "00".repeat(32),
            public_key: format!("{}79be667ef9dcbbac55a06295ce870b07029bfcdb2dce28d959f2815b16f81798", if schnorr { "" } else { "02" }),
            script_class: "p2pkh".into(),
        }
    }

    #[test]
    fn deferred_administrator_must_belong_to_the_authorized_account_before_approval() {
        use crate::protocols::coin_issuance::{build_create_plan, CreateOptions, CoinDefinition};
        let fixture: serde_json::Value = serde_json::from_str(include_str!("../../../fixtures/coin-admin-proof.json")).unwrap();
        let funding = tbc_sdk::Transaction::from_hex(fixture["issuance"]["grandparentRaw"].as_str().unwrap()).unwrap();
        let key_hex = request(false).public_key;
        let decode = |s: &str| (0..s.len()).step_by(2).map(|i| u8::from_str_radix(&s[i..i+2],16).unwrap()).collect::<Vec<_>>();
        let key = tbc_sdk::PublicKey::from_slice(&decode(&key_hex)).unwrap();
        let account = AccountIdentity { address: "bound-address".into(), account_id: "tbc:testnet:original-account".into(),
            chain_id: "tbc:testnet".into(), public_key: key_hex.clone(), label: None };
        let mut recipient = [0;21]; recipient[..20].copy_from_slice(&key.hash160());
        for (admin_hex, accepted) in [(&key_hex[2..], true), (fixture["issuance"]["publicKeyHex"].as_str().unwrap(), false)] {
            let admin: [u8;32] = decode(admin_hex).try_into().unwrap();
            let plan = build_create_plan(CreateOptions { definition: CoinDefinition { name: "Offline Coin", symbol: "OFF", decimals: 0, initial_amount: 1000 },
                administrator: &admin, fee_public_key: &key, funding: &funding, funding_outpoint: tbc_sdk::OutPoint { txid: funding.txid(), vout: 0 },
                recipient, additional_info: None, max_fee: 10000 }).unwrap();
            let first = crate::signing::begin_signing(&plan.unsigned_plan).unwrap();
            assert!(public_signing_tasks(&first, &account).is_ok(), "fee-only first stage cannot establish later authority");
            assert_eq!(authorize_plan_account(&plan.unsigned_plan, &account).is_ok(), accepted);
        }
    }

    #[test]
    fn public_wire_keeps_algorithms_distinct_and_account_identity_unchanged() {
        for schnorr in [false, true] {
            let r = request(schnorr);
            let stage = SigningStage {
                session_id: r.session_id.clone(), stage: 0, stage_commitment: r.stage_commitment.clone(),
                signing_requests: vec![r.clone()], continuation: SigningContinuation {
                    session_id: r.session_id.clone(), plan_commitment: "00".repeat(32), next_stage: 0,
                    finalized_transactions: vec![None],
                },
            };
            let account = AccountIdentity { address: "bound-address".into(), account_id: "tbc:testnet:original-account".into(),
                chain_id: "tbc:testnet".into(), public_key: request(false).public_key, label: None };
            let tasks = public_signing_tasks(&stage, &account).unwrap();
            assert_eq!(tasks[0].account_id, "tbc:testnet:original-account");
            assert_eq!(tasks[0].public_key, r.public_key);
            assert_eq!(tasks[0].task_id, "sign-tx-1-input-0");
            assert_eq!(tasks[0].signature_encoding, if schnorr { "schnorr64" } else { "compact64" });
            assert_eq!(tasks[0].algorithm, if schnorr { "secp256k1-schnorr-bip340" } else { "secp256k1-ecdsa-sha256d" });
            let mut wrong_account = account.clone(); wrong_account.public_key.replace_range(2..4, "00");
            assert!(public_signing_tasks(&stage, &wrong_account).is_err());
            let mut wrong_account = account.clone(); wrong_account.public_key = r.public_key.clone();
            if schnorr { assert!(public_signing_tasks(&stage, &wrong_account).is_err(), "x-only is not a new public account"); }
            let mut wrong = r.clone(); wrong.algorithm = if schnorr { "secp256k1-ecdsa" } else { "secp256k1-schnorr" }.into();
            assert!(signing_profile(&wrong).is_err());
            let mut wrong = r.clone(); wrong.sighash_type = 1; assert!(signing_profile(&wrong).is_err());
            let mut wrong = r; wrong.public_key.make_ascii_uppercase(); assert!(signing_profile(&wrong).is_err());
        }
    }
}
