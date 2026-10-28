use serde::{Deserialize, Serialize, ser::SerializeStruct};
use serde_json::Value;

use crate::signing::{SigningStage, UnsignedPlan};
use crate::{EngineError, ErrorCode};

pub(crate) const WIRE_VERSION: &str = "1.0";

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct NormalizeRequestParams {
    pub version: String,
    pub request: CanonicalRequest,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct NormalizeRequestResult {
    pub request: CanonicalRequest,
    pub request_hash: String,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct CanonicalRequest {
    pub version: String,
    pub chain_id: String,
    pub from: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub signing_roles: Option<Vec<RequestedSigningRole>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub client_request_id: Option<String>,
    pub intent: TransferIntent,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub constraints: Option<RequestConstraints>,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct RequestedSigningRole {
    pub role: String,
    pub account_id: String,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct ResolvedSigningRole {
    pub role: String,
    pub account: AccountIdentity,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct LopAsset {
    pub standard: String,
    pub contract_id: String,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct LopOrder {
    pub side: String,
    pub market: String,
    pub asset_a: LopAsset,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub asset_b: Option<LopAsset>,
    pub sale_volume: String,
    /// Pinned LOP integer scale is 1,000,000, not bps or display units.
    pub unit_price: String,
    pub fee_rate: String,
    pub fee_recipient: String,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct AmmFeePolicy {
    pub lp_fee_rate: u16,
    pub tax_fee_rate: u16,
    pub service_provider_fee_rate: u16,
    pub protocol_fee_rate: u16,
    pub fee_address: String,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct TransferIntent {
    #[serde(rename = "type")]
    pub intent_type: String,
    pub version: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub order: Option<LopOrder>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub to: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub amount: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub receivers: Option<Vec<Tbc20Receiver>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub slot: Option<u32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub items: Option<Vec<NftMintItem>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub transfers: Option<Vec<NftTransferItem>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub payment: Option<NativePayment>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub target_outpoints: Option<Vec<RequestedOutpoint>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub certificate_outpoint: Option<RequestedOutpoint>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub lock_time: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub hashlock: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub preimage: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub asset_standard: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub name: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub description: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub supply: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub media: Option<Value>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub symbol: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub decimals: Option<u8>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub initial_supply: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub contract_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub collection_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub attributes: Option<Vec<Value>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub attached_tbc_amount: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub ft_contract_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub pool_contract_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub stage: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub lp_plan: Option<u8>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub lp_timelock: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub controllers: Option<Vec<String>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub service_fee_rate: Option<u16>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub fee_policy: Option<AmmFeePolicy>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub direction: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub budget_asset: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub initial_ft_amount: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub maximum_tbc_amount: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub maximum_ft_amount: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub minimum_output: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub pool_state_hash: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub service_provider_tag: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub initial_liquidity: Option<PoolInitialLiquidity>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub receiver: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub tbc_amount: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub ft_amount: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub lp_amount: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub minimum_lp_amount: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub minimum_tbc_amount: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub minimum_ft_amount: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub lock: Option<PoolLock>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub lock_until_height: Option<String>,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct PoolInitialLiquidity {
    pub receiver: String,
    pub tbc_amount: String,
    pub ft_amount: String,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct Tbc20Receiver {
    pub to: String,
    pub amount: String,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct NftMintItem {
    pub slot: u32,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub to: Option<String>,
    pub name: String,
    pub symbol: String,
    pub description: String,
    pub attributes: Vec<Value>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub media: Option<Value>,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct NativePayment {
    pub to: String,
    pub amount: String,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct NftTransferItem {
    pub contract_id: String,
    pub to: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub payment: Option<NativePayment>,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct PoolLock {
    pub public_keys: Vec<String>,
    pub cost_recipient: String,
    pub cost_amount: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub until_height: Option<String>,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct RequestConstraints {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub expires_at: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub max_fee: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub fee_preference: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub input_outpoints: Option<Vec<RequestedOutpoint>>,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct RequestedOutpoint {
    pub txid: String,
    pub vout: u32,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct PlanParams {
    pub version: String,
    pub request: CanonicalRequest,
    pub request_hash: String,
    pub snapshot: ChainSnapshot,
    pub policy: ExecutionPolicy,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct ChainSnapshot {
    pub payload: SnapshotPayload,
    pub snapshot_hash: String,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct SnapshotPayload {
    pub version: String,
    pub snapshot_id: String,
    pub chain_id: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub block: Option<SnapshotBlock>,
    pub captured_at: String,
    pub expires_at: String,
    pub account: AccountIdentity,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub signing_accounts: Option<Vec<AccountIdentity>>,
    pub utxos: Vec<WalletUtxo>,
    pub parents: Vec<ParentTransaction>,
    pub contracts: Vec<ContractRecord>,
}

impl SnapshotPayload {
    /// Unknown tip is not height zero. Lock/maturity consumers must request
    /// chain context explicitly; ordinary unconfirmed transfers need none.
    pub(crate) fn require_block(&self) -> Result<&SnapshotBlock, EngineError> {
        self.block.as_ref().ok_or_else(|| error(ErrorCode::MissingMaterial,
            "this operation requires fresh chain height/time", "snapshot.payload.block"))
    }
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct ContractRecord {
    pub contract_id: String,
    pub family: String,
    pub protocol_version: String,
    pub creation_txid: String,
    pub current_outpoint: ContractOutpoint,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub standard_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub template_revision: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub genesis_outpoint: Option<ContractOutpoint>,
    /// Material from the wallet's configured, trusted asset index. This is not
    /// a DApp assertion or an independent chain-history proof. It is included
    /// in snapshotHash and all subsequent approval/plan bindings.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub indexed_fungible: Option<IndexedFungible>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub indexed_pool: Option<IndexedPool>,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct IndexedPool {
    pub ft_code_script: String,
    pub ft_tape_script: String,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct IndexedFungible {
    pub code_script: String,
    pub tape_script: String,
    pub total_supply: String,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct ContractOutpoint {
    pub txid: String,
    pub vout: u32,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct SnapshotBlock {
    pub height: String,
    pub hash: String,
    /// Optional trusted chain median time, never the device clock.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub median_time_past: Option<String>,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct AccountIdentity {
    pub address: String,
    pub account_id: String,
    pub chain_id: String,
    pub public_key: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub label: Option<String>,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct WalletUtxo {
    pub txid: String,
    pub vout: u32,
    pub satoshis: String,
    pub script_pub_key: String,
    #[serde(default, skip_serializing_if = "Option::is_none", deserialize_with = "crate::confirmations::deserialize_optional")]
    pub confirmations: Option<String>,
    pub classification: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub contract_id: Option<String>,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct ParentTransaction {
    pub txid: String,
    pub raw_transaction: String,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct ExecutionPolicy {
    pub payload: PolicyPayload,
    pub policy_hash: String,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct PolicyPayload {
    pub version: String,
    pub policy_id: String,
    pub revision: String,
    pub chain_id: String,
    pub fee_rate_sat_per_kb: String,
    pub dust_threshold: String,
    pub min_confirmations: String,
    pub max_bundle_transactions: u32,
    pub sighash_type: u32,
    pub contract_policies: Vec<Value>,
    pub amount_limits: Vec<AmountLimit>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub pool: Option<ResolvedPoolPolicy>,
    pub expires_at: String,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct ResolvedPoolPolicy {
    pub lp_plan: u8,
    pub service_provider_tag: String,
    pub service_fee_rate: u16,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct AmountLimit {
    pub scope: String,
    pub maximum: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub contract_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub protocol_version: Option<String>,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct PlanResult {
    pub plan: ExecutionPlan,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct ExecutionPlan {
    pub payload: ExecutionPlanPayload,
    pub plan_hash: String,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct ExecutionPlanPayload {
    pub version: String,
    pub request_hash: String,
    pub snapshot_hash: String,
    pub policy_hash: String,
    pub chain_id: String,
    pub account_id: String,
    pub expires_at: String,
    pub transactions: Vec<TransactionTemplate>,
    pub signing_tasks: Vec<TransactionSigningTask>,
    pub preview: TransactionPreview,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct TransactionTemplate {
    pub id: String,
    pub role: String,
    pub depends_on: Vec<String>,
    pub unsigned_transaction: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub deferred_inputs: Option<Vec<DeferredTransactionInput>>,
    pub template_hash: String,
    pub fee: String,
    /// Local output projection, committed by plan_hash. No remote metadata or
    /// origin/spendability claim; the planner/finalizer retain their checks.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub output_review: Vec<crate::output_review::OutputReview>,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct DeferredTransactionInput {
    pub input_index: u32,
    pub source_transaction_id: String,
    pub source_output_index: u32,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct TransactionSigningTask {
    pub task_id: String,
    pub purpose: String,
    pub algorithm: String,
    pub digest: String,
    pub signature_encoding: String,
    pub transaction_template_id: String,
    pub input_index: u32,
    pub account_id: String,
    pub public_key: String,
    pub sighash_type: u32,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct TransactionPreview {
    pub operation_kind: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub contract_execution: Option<ContractExecution>,
    pub asset_flows: Vec<AssetFlow>,
    pub total_fee: String,
    pub transaction_count: u32,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub signing_task_count: Option<u32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub signing_roles: Option<Vec<ResolvedSigningRole>>,
    pub warnings: Vec<String>,
    pub irreversible: bool,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct ContractExecution {
    pub business_type: String,
    pub implementation: String,
    pub generation: String,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct AssetFlow {
    pub kind: String,
    pub direction: String,
    pub amount: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub contract_id: Option<String>,
    // Contract controllers are not P2PKH addresses. Omit this optional wire
    // field rather than mislabelling the administrator as the asset owner.
    #[serde(default, skip_serializing_if = "String::is_empty")]
    pub from: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub to: Option<String>,
}

pub(crate) struct WalletMaterial<'a> {
    pub snapshot: &'a ChainSnapshot,
    pub policy: &'a ExecutionPolicy,
    // Internal-only funding already checked by the outer planner, including
    // outputs of bound prerequisites; never caller-supplied wire material.
    pub planned_native: Option<&'a [crate::funding::NativeFundingUtxo]>,
}

pub(crate) struct PlannedTransfer {
    /// Derived only from authenticated material inside this computation. Never
    /// caller-supplied wire data; outer requestHash remains the unified request.
    pub resolved_request: Option<CanonicalRequest>,
    pub result: PlanResult,
    pub unsigned_plan: UnsignedPlan,
    pub signing_stage: SigningStage,
    pub output_roles: Vec<OutputRole>,
    pub business_plan: Option<UnsignedPlan>,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub(crate) enum OutputRole {
    Recipient,
    Change,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct ValidateParams {
    pub version: String,
    pub phase: String,
    pub request: CanonicalRequest,
    pub request_hash: String,
    pub snapshot: ChainSnapshot,
    pub policy: ExecutionPolicy,
    pub plan: ExecutionPlan,
    #[serde(default)]
    pub signatures: Option<Vec<SignatureResult>>,
    #[serde(default)]
    pub bundle: Option<SignedTransactionBundle>,
    #[serde(default)]
    pub pending: Option<PendingFinalizeResult>,
    #[serde(default)]
    pub continuation: Option<FinalizeContinuation>,
    #[serde(default)]
    pub binding: Option<ApprovalBinding>,
    #[serde(default)]
    pub approval: Option<ApprovalReceipt>,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
pub(crate) struct ValidationResult {
    pub valid: bool,
    pub violations: Vec<Violation>,
}

#[derive(Clone, Debug, Deserialize, Eq, Ord, PartialEq, PartialOrd)]
#[serde(rename_all = "camelCase")]
pub(crate) struct Violation {
    pub code: String,
    pub path: Option<String>,
}

impl Serialize for Violation {
    fn serialize<S>(&self, serializer: S) -> Result<S::Ok, S::Error>
    where
        S: serde::Serializer,
    {
        let mut state = serializer.serialize_struct(
            "Violation",
            if self.path.is_some() { 2 } else { 1 },
        )?;
        state.serialize_field("code", &self.code)?;
        if let Some(path) = self.path.as_deref() {
            state.serialize_field("path", &public_violation_path(path))?;
        }
        state.end()
    }
}

fn public_violation_path(path: &str) -> String {
    if path.is_empty() {
        return String::new();
    }
    let token = path
        .strip_prefix('/')
        .unwrap_or(path)
        .split(['.', '[', '/'])
        .next()
        .unwrap_or(path);
    format!("/{}", token.replace('~', "~0").replace('/', "~1"))
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct FinalizeParams {
    pub version: String,
    pub request: CanonicalRequest,
    pub request_hash: String,
    pub snapshot: ChainSnapshot,
    pub policy: ExecutionPolicy,
    pub plan: ExecutionPlan,
    pub binding: ApprovalBinding,
    pub approval: ApprovalReceipt,
    pub signatures: Vec<SignatureResult>,
    #[serde(default)]
    pub continuation: Option<FinalizeContinuation>,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct ApprovalBinding {
    pub payload: ApprovalBindingPayload,
    pub binding_hash: String,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct ApprovalBindingPayload {
    pub version: String,
    pub method: String,
    pub operation_kind: String,
    pub context_hash: String,
    pub origin: String,
    pub session_id: String,
    pub chain_id: String,
    pub account_id: String,
    pub request_hash: String,
    pub operation_hash: String,
    pub expires_at: String,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct ApprovalReceipt {
    pub status: String,
    pub approval_id: String,
    pub approval_token: String,
    pub binding_hash: String,
    pub approved_at: String,
    pub expires_at: String,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct SignatureResult {
    pub task_id: String,
    pub signature_encoding: String,
    pub signature: String,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct FinalizeResult {
    pub bundle: SignedTransactionBundle,
    pub validation: ValidationResult,
}

#[derive(Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(untagged)]
pub(crate) enum FinalizeOutcome {
    Complete(FinalizeResult),
    Pending(PendingFinalizeResult),
}

#[derive(Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct PendingFinalizeResult {
    pub status: String,
    pub continuation: FinalizeContinuation,
    pub signing_requests: Vec<TransactionSigningTask>,
}

#[derive(Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct FinalizeContinuation {
    pub version: String,
    pub method: String,
    pub family: String,
    pub request_hash: String,
    pub plan_hash: String,
    pub binding_hash: String,
    pub approval_id: String,
    pub session_id: String,
    pub stage: u32,
    pub stage_commitment: String,
    pub signing_stage: SigningStage,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct SignedTransactionBundle {
    pub version: String,
    pub chain_id: String,
    pub from: String,
    pub request_hash: String,
    pub approval_id: String,
    pub transactions: Vec<BundleTransaction>,
    pub total_fee: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub artifacts: Option<TransactionArtifacts>,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct TransactionArtifacts {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub collection_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub contract_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub pool_contract_id: Option<String>,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct BundleTransaction {
    pub id: String,
    pub txid: String,
    pub raw_transaction: String,
    pub role: String,
    pub depends_on: Vec<String>,
}

pub(crate) fn error(code: ErrorCode, message: impl Into<String>, path: &str) -> EngineError {
    EngineError {
        code,
        message: message.into(),
        path: Some(path.to_owned()),
    }
}

pub(crate) fn parse_input<T: for<'de> Deserialize<'de>>(value: Value) -> Result<T, EngineError> {
    serde_json::from_value(value).map_err(|source| {
        error(
            ErrorCode::InvalidInput,
            format!("invalid method input: {source}"),
            "input",
        )
    })
}

pub(crate) fn to_value<T: Serialize>(value: T) -> Result<Value, EngineError> {
    serde_json::to_value(value).map_err(|_| {
        error(
            ErrorCode::InternalInvariant,
            "failed to encode Engine value",
            "result",
        )
    })
}
