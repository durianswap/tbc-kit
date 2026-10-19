use std::{
    fmt,
    time::{Duration, SystemTime, UNIX_EPOCH},
};

use reqwest::StatusCode;
use serde::{Deserialize, Deserializer, Serialize, de::DeserializeOwned};
use sha2::{Digest, Sha256};

pub use crate::{FtlpUtxo, UtxoInfo};
use crate::{
    Address, Error, OutPoint, Result, Transaction, Txid,
    contracts::ft::unlock::{ft_pre_pre_source_indexes, pre_pre_tx_data_from_parents},
    contracts::pool_nft_v2::{
        POOL_CODE_SATOSHIS, PoolState, scripts::pool_code_source_outpoint, unlock::pool_code_lock,
    },
    script::Script,
};

const MAIN_BASE_URL: &str = "https://api.turingbitchain.io/api/tbc/";
const GET_MAX_ATTEMPTS: usize = 4;
const GET_RETRY_DELAY_RANGES_MS: [(u64, u64); GET_MAX_ATTEMPTS - 1] =
    [(300, 600), (700, 1_200), (1_500, 2_500)];
const API_CONNECT_TIMEOUT: Duration = Duration::from_secs(3);
const API_REQUEST_TIMEOUT: Duration = Duration::from_secs(10);
const POOL_V2_CODE_MARKER: &[u8] = b"\x052Code";

#[derive(Clone, Debug)]
pub struct ApiClient {
    base_url: String,
    client: reqwest::Client,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct PoolNftInfo {
    pub state: PoolState,
    pub pool_code: Script,
    pub current_utxo: UtxoInfo,
}

#[derive(Clone, Debug, PartialEq, Eq, Deserialize)]
pub struct BroadcastBatchData {
    pub success: u64,
    pub failed: u64,
    pub results: Option<serde_json::Value>,
}

#[derive(Debug, Deserialize)]
struct ApiEnvelope<T> {
    #[serde(rename = "code")]
    _code: Option<serde_json::Value>,
    data: Option<T>,
    error: Option<serde_json::Value>,
    message: Option<String>,
}

#[derive(Debug, Deserialize)]
struct UtxoListData {
    utxos: Vec<ApiUtxo>,
}

#[derive(Debug, Deserialize)]
struct ApiUtxo {
    txid: String,
    index: u32,
    value: u64,
}

#[derive(Debug, Serialize)]
struct BroadcastRequest<'a> {
    txraw: &'a str,
}

#[derive(Debug, Serialize)]
struct BroadcastBatchRequest<'a> {
    txraw: &'a str,
}

#[derive(Debug, Deserialize)]
struct BroadcastData {
    txid: Option<String>,
    error: Option<String>,
}

#[derive(Debug, Deserialize)]
struct RawTransactionData {
    txraw: String,
}

#[derive(Clone, Copy, Debug)]
struct CheckedInteger(u128);

impl CheckedInteger {
    fn u8(self, field: &str) -> Result<u8> {
        u8::try_from(self.0).map_err(|_| Error::Api(format!("{field} exceeds the u8 range")))
    }

    fn u16(self, field: &str) -> Result<u16> {
        u16::try_from(self.0).map_err(|_| Error::Api(format!("{field} exceeds the u16 range")))
    }

    fn u32(self, field: &str) -> Result<u32> {
        u32::try_from(self.0).map_err(|_| Error::Api(format!("{field} exceeds the u32 range")))
    }

    fn u64(self, field: &str) -> Result<u64> {
        u64::try_from(self.0).map_err(|_| Error::Api(format!("{field} exceeds the u64 range")))
    }
}

impl<'de> Deserialize<'de> for CheckedInteger {
    fn deserialize<D>(deserializer: D) -> std::result::Result<Self, D::Error>
    where
        D: Deserializer<'de>,
    {
        struct IntegerVisitor;

        impl serde::de::Visitor<'_> for IntegerVisitor {
            type Value = CheckedInteger;

            fn expecting(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
                formatter.write_str("a non-negative integer or decimal integer string")
            }

            fn visit_u64<E>(self, value: u64) -> std::result::Result<Self::Value, E> {
                Ok(CheckedInteger(u128::from(value)))
            }

            fn visit_str<E>(self, value: &str) -> std::result::Result<Self::Value, E>
            where
                E: serde::de::Error,
            {
                if value.is_empty() || !value.bytes().all(|byte| byte.is_ascii_digit()) {
                    return Err(E::custom("integer string contains non-decimal characters"));
                }
                value
                    .parse::<u128>()
                    .map(CheckedInteger)
                    .map_err(|_| E::custom("integer string exceeds the u128 range"))
            }
        }

        deserializer.deserialize_any(IntegerVisitor)
    }
}

#[derive(Debug, Deserialize)]
struct PoolInfoData {
    lp_balance: CheckedInteger,
    token_balance: CheckedInteger,
    tbc_balance: CheckedInteger,
    ft_lp_partial_hash: String,
    ft_a_partial_hash: String,
    ft_contract_id: String,
    service_fee_rate: CheckedInteger,
    service_provider: String,
    pool_code_script: String,
    version: CheckedInteger,
    txid: String,
    vout: CheckedInteger,
    value: CheckedInteger,
}

#[derive(Debug, Deserialize)]
struct FtlpListData {
    #[serde(default, deserialize_with = "deserialize_null_as_empty_ftlp_utxos")]
    utxos: Vec<ApiFtlpUtxo>,
}

#[derive(Debug, Deserialize)]
struct ApiFtlpUtxo {
    txid: String,
    index: CheckedInteger,
    tbc_balance: CheckedInteger,
    #[serde(rename = "decimal")]
    _decimal: CheckedInteger,
    #[serde(alias = "ftBalance")]
    lp_balance: CheckedInteger,
}

fn deserialize_null_as_empty_ftlp_utxos<'de, D>(
    deserializer: D,
) -> std::result::Result<Vec<ApiFtlpUtxo>, D::Error>
where
    D: Deserializer<'de>,
{
    Ok(Option::<Vec<ApiFtlpUtxo>>::deserialize(deserializer)?.unwrap_or_default())
}

impl ApiClient {
    pub fn main() -> Self {
        Self::with_base_url(MAIN_BASE_URL)
    }

    pub fn with_base_url(base_url: impl Into<String>) -> Self {
        let mut base_url = base_url.into();
        if !base_url.ends_with('/') {
            base_url.push('/');
        }
        Self {
            base_url,
            client: reqwest::Client::builder()
                .connect_timeout(API_CONNECT_TIMEOUT)
                .timeout(API_REQUEST_TIMEOUT)
                .build()
                .expect("static API client timeout configuration is valid"),
        }
    }

    pub fn base_url(&self) -> &str {
        &self.base_url
    }

    async fn get_envelope<T: DeserializeOwned>(&self, url: String) -> Result<ApiEnvelope<T>> {
        for attempt in 0..GET_MAX_ATTEMPTS {
            let response = self.client.get(&url).send().await?;
            let status = response.status();
            if is_retryable_get_status(status) && attempt + 1 < GET_MAX_ATTEMPTS {
                tokio::time::sleep(get_retry_delay(attempt, retry_entropy())).await;
                continue;
            }
            if !status.is_success() {
                return Err(Error::Api(format!(
                    "GET {url} returned HTTP status {status}"
                )));
            }
            let body = response.text().await?;
            return Ok(serde_json::from_str(&body)?);
        }
        unreachable!("bounded GET loop always returns on its final attempt")
    }

    pub async fn fetch_address_utxos(&self, address: &Address) -> Result<Vec<UtxoInfo>> {
        let url = format!("{}utxo/address/{}", self.base_url, address);
        let envelope: ApiEnvelope<UtxoListData> = self.get_envelope(url).await?;
        if let Some(error) = envelope.error {
            return Err(Error::Api(error.to_string()));
        }
        let data = envelope
            .data
            .ok_or_else(|| Error::Api(envelope.message.unwrap_or_else(|| "missing data".into())))?;
        let script_pubkey = address.script_pubkey();
        data.utxos
            .into_iter()
            .map(|utxo| {
                Ok(UtxoInfo {
                    outpoint: OutPoint {
                        txid: utxo.txid.parse::<Txid>()?,
                        vout: utxo.index,
                    },
                    satoshis: utxo.value,
                    script_pubkey: script_pubkey.clone(),
                })
            })
            .collect()
    }

    /// Fetches every UTXO locked by an arbitrary script.
    ///
    /// The TBC indexer identifies scripts by the byte-reversed SHA-256 digest
    /// of their raw serialized bytes.
    pub async fn fetch_script_utxos(&self, locking_script: &Script) -> Result<Vec<UtxoInfo>> {
        let mut script_hash = Sha256::digest(locking_script.as_bytes()).to_vec();
        script_hash.reverse();
        let url = format!(
            "{}utxo/scriptpubkeyhash/{}",
            self.base_url,
            hex::encode(script_hash)
        );
        let envelope: ApiEnvelope<UtxoListData> = self.get_envelope(url).await?;
        if let Some(error) = envelope.error {
            return Err(Error::Api(error.to_string()));
        }
        let data = envelope
            .data
            .ok_or_else(|| Error::Api(envelope.message.unwrap_or_else(|| "missing data".into())))?;
        data.utxos
            .into_iter()
            .map(|utxo| {
                Ok(UtxoInfo {
                    outpoint: OutPoint {
                        txid: utxo.txid.parse::<Txid>()?,
                        vout: utxo.index,
                    },
                    satoshis: utxo.value,
                    script_pubkey: locking_script.clone(),
                })
            })
            .collect()
    }

    /// Fetches all UTXOs for a script and requires their checked total to meet
    /// `minimum_sat`.
    pub async fn fetch_script_utxos_at_least(
        &self,
        locking_script: &Script,
        minimum_sat: u64,
    ) -> Result<Vec<UtxoInfo>> {
        let utxos = self.fetch_script_utxos(locking_script).await?;
        let total = utxos.iter().try_fold(0u64, |total, utxo| {
            total
                .checked_add(utxo.satoshis)
                .ok_or_else(|| Error::InvalidUtxo("custom-script UTXO amount overflow".to_string()))
        })?;
        if total < minimum_sat {
            return Err(Error::InsufficientFunds {
                input: total,
                required: minimum_sat,
            });
        }
        Ok(utxos)
    }

    pub async fn broadcast_raw_transaction(&self, raw_hex: &str) -> Result<String> {
        let url = format!("{}broadcasttx", self.base_url);
        let envelope: ApiEnvelope<BroadcastData> = self
            .client
            .post(url)
            .json(&BroadcastRequest { txraw: raw_hex })
            .send()
            .await?
            .json()
            .await?;

        if let Some(error) = envelope.error {
            return Err(Error::BroadcastFailure(error.to_string()));
        }
        let message = envelope.message.unwrap_or_else(|| "missing txid".into());
        let data = envelope
            .data
            .ok_or_else(|| Error::BroadcastFailure(message.clone()))?;
        if let Some(error) = data.error {
            return Err(Error::BroadcastFailure(error));
        }
        data.txid
            .ok_or_else(|| Error::BroadcastFailure(message.clone()))
    }

    pub async fn broadcast_raw_transactions(
        &self,
        raw_hexes: &[String],
    ) -> Result<BroadcastBatchData> {
        let url = format!("{}broadcasttxs", self.base_url);
        let requests = raw_hexes
            .iter()
            .map(|raw| BroadcastBatchRequest { txraw: raw })
            .collect::<Vec<_>>();
        let envelope: ApiEnvelope<BroadcastBatchData> = self
            .client
            .post(url)
            .json(&requests)
            .send()
            .await?
            .json()
            .await?;

        if let Some(error) = envelope.error {
            return Err(Error::BroadcastFailure(error.to_string()));
        }
        envelope.data.ok_or_else(|| {
            Error::BroadcastFailure(
                envelope
                    .message
                    .unwrap_or_else(|| "missing batch data".into()),
            )
        })
    }

    pub async fn fetch_raw_transaction(&self, txid: &str) -> Result<Transaction> {
        let url = format!("{}txraw/txid/{}", self.base_url, txid);
        let envelope: ApiEnvelope<RawTransactionData> = self.get_envelope(url).await?;
        if let Some(error) = envelope.error {
            return Err(Error::Api(error.to_string()));
        }
        let data = envelope
            .data
            .ok_or_else(|| Error::Api(envelope.message.unwrap_or_else(|| "missing data".into())))?;
        Transaction::from_hex(&data.txraw)
    }

    pub async fn fetch_pool_nft_info(&self, contract_id: &Txid) -> Result<PoolNftInfo> {
        let url = format!("{}pool/poolinfo/poolid/{}", self.base_url, contract_id);
        let envelope: ApiEnvelope<PoolInfoData> = self.get_envelope(url).await?;
        let data = envelope_data(envelope)?;

        let version = data.version.u8("Pool version")?;
        if version != 2 {
            return Err(Error::Api(format!(
                "unsupported Pool version {version}; only Pool NFT v2 is supported"
            )));
        }

        let endpoint_lp = data.lp_balance.u64("Pool LP balance")?;
        let endpoint_ft = data.token_balance.u64("Pool token balance")?;
        let endpoint_tbc = data.tbc_balance.u64("Pool TBC balance")?;
        let endpoint_fee = data.service_fee_rate.u16("Pool service fee rate")?;
        let endpoint_lp_hash = checked_hex(&data.ft_lp_partial_hash, 32, "Pool LP partial hash")?;
        let endpoint_ft_hash = checked_hex(&data.ft_a_partial_hash, 32, "Pool FT partial hash")?;
        let endpoint_ft_id = data.ft_contract_id.parse::<Txid>()?;
        let current_txid = data.txid.parse::<Txid>()?;
        let current_vout = data.vout.u32("Pool current vout")?;
        if current_vout != 0 {
            return Err(Error::Api(
                "Pool NFT v2 current output must be vout 0".to_string(),
            ));
        }
        let current_value = data.value.u64("Pool current value")?;
        let pool_code =
            Script::from_bytes(checked_hex(&data.pool_code_script, 0, "Pool code script")?);
        if !pool_code.as_bytes().ends_with(POOL_V2_CODE_MARKER) {
            return Err(Error::Api(
                "Pool NFT v2 code must end with the canonical 2Code marker".to_string(),
            ));
        }

        let contract_tx = self.fetch_raw_transaction(&contract_id.to_string()).await?;
        if contract_tx.txid() != *contract_id {
            return Err(Error::Api(
                "Pool contract id does not match its raw creation transaction".to_string(),
            ));
        }
        if contract_tx.inputs.len() != 1 {
            return Err(Error::Api(
                "Pool creation transaction must contain exactly one input".to_string(),
            ));
        }
        let creation_output = contract_tx.outputs.first().ok_or_else(|| {
            Error::Api("Pool creation transaction is missing Pool Code at vout 0".into())
        })?;
        if creation_output.satoshis != POOL_CODE_SATOSHIS
            || creation_output.script_pubkey != pool_code
        {
            return Err(Error::Api(
                "Pool creation vout 0 does not match the released Pool Code output".to_string(),
            ));
        }
        let source_outpoint =
            pool_code_source_outpoint(&creation_output.script_pubkey).map_err(|error| {
                Error::Api(format!("invalid Pool creation source outpoint: {error}"))
            })?;
        if contract_tx.inputs[0].previous_output != source_outpoint {
            return Err(Error::Api(
                "Pool creation input does not spend the Pool Code source outpoint".to_string(),
            ));
        }
        let creation_tape = contract_tx.outputs.get(1).ok_or_else(|| {
            Error::Api("Pool creation transaction is missing NTape at vout 1".into())
        })?;
        if creation_tape.satoshis != 0 {
            return Err(Error::Api(
                "Pool creation NTape at vout 1 must contain zero satoshis".to_string(),
            ));
        }

        let current_tx = self
            .fetch_raw_transaction(&current_txid.to_string())
            .await?;
        if current_tx.txid() != current_txid {
            return Err(Error::Api(
                "Pool current transaction id does not match its raw transaction".to_string(),
            ));
        }
        let current_output = current_tx
            .outputs
            .get(current_vout as usize)
            .ok_or_else(|| Error::Api("Pool current vout is absent from its transaction".into()))?;
        if current_output.satoshis != current_value || current_output.script_pubkey != pool_code {
            return Err(Error::Api(
                "Pool current output does not match the indexer response".to_string(),
            ));
        }
        let tape = current_tx.outputs.get(1).ok_or_else(|| {
            Error::Api("Pool current transaction is missing NTape at vout 1".into())
        })?;
        if tape.satoshis != 0 {
            return Err(Error::Api(
                "Pool NFT v2 NTape at vout 1 must contain zero satoshis".to_string(),
            ));
        }
        let state = PoolState::from_v2_tape(&tape.script_pubkey, data.service_provider)?;
        let expected_pool_value = POOL_CODE_SATOSHIS
            .checked_add(state.amounts.tbc_sat)
            .ok_or_else(|| Error::Api("Pool Code value overflow".to_string()))?;
        if current_value < expected_pool_value {
            return Err(Error::Api(format!(
                "Pool Code value {current_value} is below {POOL_CODE_SATOSHIS} plus the {} satoshi TBC reserve",
                state.amounts.tbc_sat
            )));
        }
        let creation_state =
            PoolState::from_v2_tape(&creation_tape.script_pubkey, state.service_provider.clone())?;
        if creation_state.amounts.ft_lp_raw != 0
            || creation_state.amounts.ft_a_raw != 0
            || creation_state.amounts.tbc_sat != 0
            || creation_state.ft_lp_partial_hash != state.ft_lp_partial_hash
            || creation_state.ft_a_partial_hash != state.ft_a_partial_hash
            || creation_state.ft_a_contract_id != state.ft_a_contract_id
            || creation_state.service_fee_rate != state.service_fee_rate
            || creation_state.lp_plan != state.lp_plan
            || creation_state.public_key_locked != state.public_key_locked
            || creation_state.ftlp_lock_time_enabled != state.ftlp_lock_time_enabled
        {
            return Err(Error::Api(
                "Pool creation NTape does not match the released initial Pool state".to_string(),
            ));
        }
        let code_has_public_key_lock = !pool_code_lock(&pool_code)?.is_empty();
        if state.public_key_locked != code_has_public_key_lock {
            return Err(Error::Api(
                "Pool NTape public-key lock flag does not match the released Pool code length discriminator"
                    .to_string(),
            ));
        }

        if state.amounts.ft_lp_raw != endpoint_lp
            || state.amounts.ft_a_raw != endpoint_ft
            || state.amounts.tbc_sat != endpoint_tbc
            || state.service_fee_rate != endpoint_fee
            || state.ft_lp_partial_hash != endpoint_lp_hash
            || state.ft_a_partial_hash != endpoint_ft_hash
            || state.ft_a_contract_id != endpoint_ft_id
        {
            return Err(Error::Api(
                "Pool endpoint state does not match the current NTape".to_string(),
            ));
        }

        let current_utxo = UtxoInfo {
            outpoint: OutPoint {
                txid: current_txid,
                vout: current_vout,
            },
            satoshis: current_value,
            script_pubkey: pool_code.clone(),
        };
        Ok(PoolNftInfo {
            state,
            pool_code,
            current_utxo,
        })
    }

    pub async fn fetch_pool_nft_utxo(&self, contract_id: &Txid) -> Result<UtxoInfo> {
        Ok(self.fetch_pool_nft_info(contract_id).await?.current_utxo)
    }

    pub async fn fetch_ftlp_balance(&self, code: &Script) -> Result<u128> {
        self.fetch_ftlp_utxos(code)
            .await?
            .into_iter()
            .try_fold(0u128, |total, utxo| {
                total
                    .checked_add(utxo.ft_balance_raw)
                    .ok_or_else(|| Error::Api("FTLP balance overflow".to_string()))
            })
    }

    pub async fn fetch_ftlp_utxos(&self, code: &Script) -> Result<Vec<FtlpUtxo>> {
        let mut script_hash = Sha256::digest(code.as_bytes()).to_vec();
        script_hash.reverse();
        let url = format!(
            "{}pool/lputxo/scriptpubkeyhash/{}",
            self.base_url,
            hex::encode(script_hash)
        );
        let envelope: ApiEnvelope<FtlpListData> = self.get_envelope(url).await?;
        let data = envelope_data(envelope)?;
        data.utxos
            .into_iter()
            .map(|utxo| {
                let decimal = utxo._decimal.u8("FTLP decimal")?;
                if decimal > 18 {
                    return Err(Error::Api("FTLP decimal exceeds 18".to_string()));
                }
                Ok(FtlpUtxo {
                    base: UtxoInfo {
                        outpoint: OutPoint {
                            txid: utxo.txid.parse::<Txid>()?,
                            vout: utxo.index.u32("FTLP vout")?,
                        },
                        satoshis: utxo.tbc_balance.u64("FTLP TBC balance")?,
                        script_pubkey: code.clone(),
                    },
                    ft_balance_raw: utxo.lp_balance.0,
                })
            })
            .collect()
    }

    pub async fn fetch_ftlp_utxo_for_amount(
        &self,
        code: &Script,
        amount_raw: u128,
    ) -> Result<FtlpUtxo> {
        let utxos = self.fetch_ftlp_utxos(code).await?;
        if utxos.is_empty() {
            return Err(Error::Api(format!(
                "insufficient FTLP balance: available 0, required {amount_raw}"
            )));
        }
        if let Some(utxo) = utxos.iter().find(|utxo| utxo.ft_balance_raw >= amount_raw) {
            return Ok(utxo.clone());
        }
        let total = utxos.iter().try_fold(0u128, |total, utxo| {
            total
                .checked_add(utxo.ft_balance_raw)
                .ok_or_else(|| Error::Api("FTLP balance overflow".to_string()))
        })?;
        if total < amount_raw {
            Err(Error::Api(format!(
                "insufficient FTLP balance: available {total}, required {amount_raw}"
            )))
        } else {
            Err(Error::Api(
                "FTLP balance is fragmented; merge FTLP UTXOs first".to_string(),
            ))
        }
    }

    pub async fn fetch_ft_pre_pre_tx_data(
        &self,
        pre_tx: &Transaction,
        pre_tx_vout: usize,
    ) -> Result<Vec<u8>> {
        let parents = self
            .fetch_ft_pre_pre_transactions(pre_tx, pre_tx_vout)
            .await?;
        pre_pre_tx_data_from_parents(pre_tx, pre_tx_vout, &parents)
    }

    /// Fetches the exact FT ancestry transactions referenced by the tape
    /// slots for `pre_tx_vout`.  Pool online resolvers retain these concrete
    /// parents for the offline builders' explicit validation.
    pub async fn fetch_ft_pre_pre_transactions(
        &self,
        pre_tx: &Transaction,
        pre_tx_vout: usize,
    ) -> Result<Vec<Transaction>> {
        let source_indexes = ft_pre_pre_source_indexes(pre_tx, pre_tx_vout)?;
        let mut parents = Vec::with_capacity(source_indexes.len());
        for input_index in source_indexes {
            let input = pre_tx.inputs.get(input_index).ok_or_else(|| {
                Error::InvalidUtxo(format!(
                    "FT tape references missing input index {input_index}"
                ))
            })?;
            let expected_txid = input.previous_output.txid;
            let parent = self
                .fetch_raw_transaction(&expected_txid.to_string())
                .await?;
            if parent.txid() != expected_txid {
                return Err(Error::Api(
                    "FT parent response transaction id does not match the referenced input"
                        .to_string(),
                ));
            }
            parents.push(parent);
        }
        Ok(parents)
    }
}

fn is_retryable_get_status(status: StatusCode) -> bool {
    matches!(
        status,
        StatusCode::BAD_GATEWAY | StatusCode::SERVICE_UNAVAILABLE | StatusCode::GATEWAY_TIMEOUT
    )
}

fn get_retry_delay(retry_index: usize, entropy: u64) -> Duration {
    let (minimum_ms, maximum_ms) = GET_RETRY_DELAY_RANGES_MS[retry_index];
    let range_ms = maximum_ms - minimum_ms;
    let offset_ms = (u128::from(entropy) * u128::from(range_ms) / u128::from(u64::MAX)) as u64;
    Duration::from_millis(minimum_ms + offset_ms)
}

fn retry_entropy() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_nanos() as u64
}

fn envelope_data<T>(envelope: ApiEnvelope<T>) -> Result<T> {
    if let Some(error) = envelope.error {
        return Err(Error::Api(error.to_string()));
    }
    if let Some(code) = envelope._code
        && !matches!(
            &code,
            serde_json::Value::Number(number)
                if number.as_u64() == Some(0) || number.as_u64() == Some(200)
        )
        && !matches!(
            &code,
            serde_json::Value::String(value)
                if value.is_empty() || value == "0" || value == "200"
        )
    {
        return Err(Error::Api(envelope.message.unwrap_or_else(|| {
            format!("API returned non-success code {code}")
        })));
    }
    envelope
        .data
        .ok_or_else(|| Error::Api(envelope.message.unwrap_or_else(|| "missing data".into())))
}

fn checked_hex(value: &str, expected_len: usize, field: &str) -> Result<Vec<u8>> {
    let bytes =
        hex::decode(value).map_err(|error| Error::Api(format!("invalid {field}: {error}")))?;
    if expected_len != 0 && bytes.len() != expected_len {
        return Err(Error::Api(format!(
            "{field} must contain {expected_len} bytes"
        )));
    }
    Ok(bytes)
}

#[cfg(test)]
mod api_tests {
    use std::{
        io::{Read, Write},
        net::TcpListener,
        str::FromStr,
        thread,
    };

    use crate::{
        Error, OutPoint, Transaction, TxIn, TxOut, Txid,
        contracts::pool_nft_v2::{PoolAmounts, PoolState, pool_tape},
        script::Script,
    };

    fn mock_api(body: &str) -> (String, thread::JoinHandle<String>) {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let address = listener.local_addr().unwrap();
        let body = body.to_string();
        let handle = thread::spawn(move || {
            let (mut stream, _) = listener.accept().unwrap();
            let mut request = [0u8; 8_192];
            let read = stream.read(&mut request).unwrap();
            let request = String::from_utf8_lossy(&request[..read]).to_string();
            let response = format!(
                "HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{}",
                body.len(),
                body
            );
            stream.write_all(response.as_bytes()).unwrap();
            request
        });
        (format!("http://{address}/api/tbc/"), handle)
    }

    fn mock_api_sequence(
        responses: Vec<(u16, String)>,
    ) -> (String, thread::JoinHandle<Vec<String>>) {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let address = listener.local_addr().unwrap();
        let handle = thread::spawn(move || {
            responses
                .into_iter()
                .map(|(status, body)| {
                    let (mut stream, _) = listener.accept().unwrap();
                    let mut request = [0u8; 8_192];
                    let read = stream.read(&mut request).unwrap();
                    let request = String::from_utf8_lossy(&request[..read]).to_string();
                    let reason = match status {
                        200 => "OK",
                        500 => "Internal Server Error",
                        502 => "Bad Gateway",
                        503 => "Service Unavailable",
                        504 => "Gateway Timeout",
                        _ => "Test Status",
                    };
                    let response = format!(
                        "HTTP/1.1 {status} {reason}\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{}",
                        body.len(),
                        body
                    );
                    stream.write_all(response.as_bytes()).unwrap();
                    request
                })
                .collect()
        });
        (format!("http://{address}/api/tbc/"), handle)
    }

    struct PoolResponses {
        contract_id: Txid,
        current_txid: Txid,
        info: String,
        contract_raw: String,
        current_raw: String,
    }

    #[test]
    fn get_retry_delays_stay_within_the_approved_ranges() {
        let ranges = [(300, 600), (700, 1_200), (1_500, 2_500)];

        for (retry_index, (minimum_ms, maximum_ms)) in ranges.into_iter().enumerate() {
            assert_eq!(
                super::get_retry_delay(retry_index, 0).as_millis(),
                minimum_ms
            );
            assert_eq!(
                super::get_retry_delay(retry_index, u64::MAX).as_millis(),
                maximum_ms
            );
        }
    }

    #[tokio::test(start_paused = true)]
    async fn get_retry_delay_uses_non_blocking_tokio_time() {
        let started_at = tokio::time::Instant::now();

        tokio::time::sleep(super::get_retry_delay(2, u64::MAX)).await;

        assert_eq!(
            started_at.elapsed(),
            std::time::Duration::from_millis(2_500)
        );
    }

    #[test]
    fn api_client_timeout_policy_stays_bounded() {
        assert_eq!(
            super::API_CONNECT_TIMEOUT,
            std::time::Duration::from_secs(3)
        );
        assert_eq!(
            super::API_REQUEST_TIMEOUT,
            std::time::Duration::from_secs(10)
        );
    }

    fn pool_responses() -> PoolResponses {
        let state = PoolState {
            amounts: PoolAmounts {
                ft_lp_raw: 1_000,
                ft_a_raw: 2_000,
                tbc_sat: 3_000,
            },
            ft_lp_partial_hash: vec![0x11; 32],
            ft_a_partial_hash: vec![0x22; 32],
            ft_a_contract_id: Txid::from_str(&"33".repeat(32)).unwrap(),
            service_fee_rate: 35,
            service_provider: "fixture-provider".to_string(),
            lp_plan: 2,
            public_key_locked: true,
            ftlp_lock_time_enabled: true,
        };
        let pool_code = released_pool_code("lockedPoolOneKey");
        let mut creation_tx = Transaction::new();
        creation_tx.inputs.push(TxIn::new(OutPoint {
            txid: Txid::from_str(
                "00112233445566778899aabbccddeeff00112233445566778899aabbccddeeff",
            )
            .unwrap(),
            vout: 7,
        }));
        creation_tx.outputs.push(TxOut {
            satoshis: crate::contracts::pool_nft_v2::POOL_CODE_SATOSHIS,
            script_pubkey: pool_code.clone(),
        });
        let mut creation_state = state.clone();
        creation_state.amounts = PoolAmounts {
            ft_lp_raw: 0,
            ft_a_raw: 0,
            tbc_sat: 0,
        };
        creation_tx.outputs.push(TxOut {
            satoshis: 0,
            script_pubkey: pool_tape(&creation_state).unwrap(),
        });
        let contract_id = creation_tx.txid();
        let mut current_tx = Transaction::new();
        current_tx.inputs.push(TxIn::new(OutPoint {
            txid: contract_id,
            vout: 0,
        }));
        current_tx.outputs.push(TxOut {
            satoshis: 4_000,
            script_pubkey: pool_code.clone(),
        });
        current_tx.outputs.push(TxOut {
            satoshis: 0,
            script_pubkey: pool_tape(&state).unwrap(),
        });
        let current_txid = current_tx.txid();
        let info = serde_json::json!({
            "code": "200",
            "data": {
                "lp_balance": "1000",
                "token_balance": 2000,
                "tbc_balance": "3000",
                "ft_lp_partial_hash": "11".repeat(32),
                "ft_a_partial_hash": "22".repeat(32),
                "ft_contract_id": "33".repeat(32),
                "service_fee_rate": "35",
                "service_provider": "fixture-provider",
                "pool_code_script": hex::encode(pool_code.as_bytes()),
                "version": "2",
                "txid": current_txid.to_string(),
                "vout": "0",
                "value": 4000
            }
        })
        .to_string();
        let contract_raw = serde_json::json!({
            "code": 200,
            "data": {"txraw": creation_tx.to_hex()}
        })
        .to_string();
        let current_raw = serde_json::json!({
            "code": 200,
            "data": {"txraw": current_tx.to_hex()}
        })
        .to_string();
        PoolResponses {
            contract_id,
            current_txid,
            info,
            contract_raw,
            current_raw,
        }
    }

    fn released_pool_code(name: &str) -> Script {
        let fixture: serde_json::Value =
            serde_json::from_str(include_str!("../tests/fixtures/pool-v2-js-165.json")).unwrap();
        let hex = fixture["scripts"][name]["hex"].as_str().unwrap();
        Script::from_bytes(hex::decode(hex).unwrap())
    }

    fn replace_current_transaction(
        info: &mut serde_json::Value,
        raw: &mut serde_json::Value,
        transaction: &Transaction,
    ) {
        let output = &transaction.outputs[0];
        info["data"]["txid"] = serde_json::json!(transaction.txid().to_string());
        info["data"]["value"] = serde_json::json!(output.satoshis);
        info["data"]["pool_code_script"] =
            serde_json::json!(hex::encode(output.script_pubkey.as_bytes()));
        raw["data"]["txraw"] = serde_json::json!(transaction.to_hex());
    }

    fn replace_contract_transaction(fixture: &mut PoolResponses, transaction: &Transaction) {
        fixture.contract_id = transaction.txid();
        fixture.contract_raw = serde_json::json!({
            "code": 200,
            "data": {"txraw": transaction.to_hex()}
        })
        .to_string();
    }

    fn contract_transaction(fixture: &PoolResponses) -> Transaction {
        let raw: serde_json::Value = serde_json::from_str(&fixture.contract_raw).unwrap();
        Transaction::from_hex(raw["data"]["txraw"].as_str().unwrap()).unwrap()
    }

    fn current_transaction(fixture: &PoolResponses) -> Transaction {
        let raw: serde_json::Value = serde_json::from_str(&fixture.current_raw).unwrap();
        Transaction::from_hex(raw["data"]["txraw"].as_str().unwrap()).unwrap()
    }

    fn ftlp_response(entries: serde_json::Value) -> String {
        serde_json::json!({"code": "200", "data": {"utxos": entries}}).to_string()
    }

    fn utxo_response(values: &[u64]) -> String {
        let utxos = values
            .iter()
            .enumerate()
            .map(|(index, value)| {
                serde_json::json!({
                    "txid": format!("{:064x}", index + 1),
                    "index": index,
                    "value": value,
                })
            })
            .collect::<Vec<_>>();
        serde_json::json!({"code": 200, "data": {"utxos": utxos}}).to_string()
    }

    #[test]
    fn api_main_uses_public_tbc_base_url() {
        let api = crate::ApiClient::main();
        assert_eq!(api.base_url(), "https://api.turingbitchain.io/api/tbc/");
    }

    #[test]
    fn ft_pre_pre_source_indexes_follow_tape_slots_in_reverse_order() {
        let mut tx = Transaction::new();
        tx.inputs.resize_with(6, || {
            crate::TxIn::new(crate::OutPoint {
                txid: crate::Txid::default(),
                vout: 0,
            })
        });
        tx.outputs.push(TxOut {
            satoshis: 500,
            script_pubkey: Script::from_bytes(vec![0x51]),
        });

        let mut tape = vec![0x00, 0x6a, 0x30];
        tape.extend_from_slice(&0u64.to_le_bytes());
        tape.extend_from_slice(&7u64.to_le_bytes());
        tape.extend_from_slice(&0u64.to_le_bytes());
        tape.extend_from_slice(&9u64.to_le_bytes());
        tape.extend_from_slice(&0u64.to_le_bytes());
        tape.extend_from_slice(&11u64.to_le_bytes());
        tape.extend_from_slice(b"FTape");
        tx.outputs.push(TxOut {
            satoshis: 0,
            script_pubkey: Script::from_bytes(tape),
        });

        assert_eq!(
            super::ft_pre_pre_source_indexes(&tx, 0).unwrap(),
            vec![5, 3, 1]
        );
    }

    #[test]
    fn batch_broadcast_response_parses_partial_failure() {
        let json = r#"{
            "code": "400",
            "message": "partial failure",
            "data": {
                "success": 49,
                "failed": 1,
                "results": [{"txid": "abc"}, {"error": "missing inputs"}]
            }
        }"#;

        let envelope: super::ApiEnvelope<super::BroadcastBatchData> =
            serde_json::from_str(json).unwrap();
        let data = envelope.data.unwrap();

        assert_eq!(data.success, 49);
        assert_eq!(data.failed, 1);
        assert!(data.results.unwrap().is_array());
    }

    #[tokio::test]
    async fn custom_script_utxos_decode_reversed_sha256_and_restore_script() {
        let locking_script = Script::from_bytes(vec![0x51]);
        let (base_url, request) = mock_api(&utxo_response(&[100, 200]));
        let utxos = crate::ApiClient::with_base_url(base_url)
            .fetch_script_utxos(&locking_script)
            .await
            .unwrap();
        let request = request.join().unwrap();

        assert!(request.starts_with(
            "GET /api/tbc/utxo/scriptpubkeyhash/6032c38c0bc0e91e726f1e55e1832e434509001a7aed5cfd881b6ef07215e84a "
        ));
        assert_eq!(utxos.len(), 2);
        assert_eq!(utxos[0].satoshis, 100);
        assert_eq!(utxos[1].outpoint.vout, 1);
        assert!(
            utxos
                .iter()
                .all(|utxo| utxo.script_pubkey == locking_script)
        );
    }

    #[tokio::test]
    async fn custom_script_utxos_at_least_checks_total_and_insufficient_funds() {
        let locking_script = Script::from_bytes(vec![0x51]);
        let (base_url, request) = mock_api(&utxo_response(&[100, 200]));
        let utxos = crate::ApiClient::with_base_url(base_url)
            .fetch_script_utxos_at_least(&locking_script, 300)
            .await
            .unwrap();
        request.join().unwrap();
        assert_eq!(utxos.len(), 2);

        let (base_url, request) = mock_api(&utxo_response(&[100, 200]));
        let error = crate::ApiClient::with_base_url(base_url)
            .fetch_script_utxos_at_least(&locking_script, 301)
            .await
            .unwrap_err();
        request.join().unwrap();
        assert!(matches!(
            error,
            Error::InsufficientFunds {
                input: 300,
                required: 301
            }
        ));
    }

    #[tokio::test]
    async fn custom_script_utxos_at_least_rejects_amount_overflow() {
        let locking_script = Script::from_bytes(vec![0x51]);
        let (base_url, request) = mock_api(&utxo_response(&[u64::MAX, 1]));
        let error = crate::ApiClient::with_base_url(base_url)
            .fetch_script_utxos_at_least(&locking_script, 0)
            .await
            .unwrap_err();
        request.join().unwrap();
        assert!(matches!(error, Error::InvalidUtxo(message) if message.contains("overflow")));
    }

    #[tokio::test]
    async fn custom_script_utxos_propagate_api_error_envelope() {
        let locking_script = Script::from_bytes(vec![0x51]);
        let body = serde_json::json!({"code": 500, "error": "index unavailable"}).to_string();
        let (base_url, request) = mock_api(&body);
        let error = crate::ApiClient::with_base_url(base_url)
            .fetch_script_utxos(&locking_script)
            .await
            .unwrap_err();
        request.join().unwrap();
        assert!(matches!(error, Error::Api(message) if message.contains("index unavailable")));
    }

    #[tokio::test]
    async fn pool_info_normalizes_integer_strings_and_binds_current_tape_state() {
        let fixture = pool_responses();
        let current_tx = current_transaction(&fixture);
        let (base_url, requests) = mock_api_sequence(vec![
            (200, fixture.info),
            (200, fixture.contract_raw),
            (200, fixture.current_raw),
        ]);

        let info = crate::ApiClient::with_base_url(base_url)
            .fetch_pool_nft_info(&fixture.contract_id)
            .await
            .unwrap();
        let requests = requests.join().unwrap();

        assert!(requests[0].starts_with(&format!(
            "GET /api/tbc/pool/poolinfo/poolid/{} ",
            fixture.contract_id
        )));
        assert!(
            requests[1].starts_with(&format!("GET /api/tbc/txraw/txid/{} ", fixture.contract_id))
        );
        assert!(requests[2].starts_with(&format!(
            "GET /api/tbc/txraw/txid/{} ",
            fixture.current_txid
        )));
        assert_eq!(current_tx.inputs.len(), 1);
        assert_eq!(
            current_tx.inputs[0].previous_output,
            OutPoint {
                txid: fixture.contract_id,
                vout: 0,
            }
        );
        assert_eq!(info.state.amounts.ft_lp_raw, 1_000);
        assert_eq!(info.state.amounts.ft_a_raw, 2_000);
        assert_eq!(info.state.amounts.tbc_sat, 3_000);
        assert_eq!(info.state.service_fee_rate, 35);
        assert_eq!(info.state.lp_plan, 2);
        assert!(info.state.public_key_locked);
        assert!(info.state.ftlp_lock_time_enabled);
        assert_eq!(info.current_utxo.outpoint.txid, fixture.current_txid);
        assert_eq!(info.current_utxo.outpoint.vout, 0);
        assert_eq!(info.current_utxo.satoshis, 4_000);
        assert_eq!(
            info.current_utxo.script_pubkey,
            released_pool_code("lockedPoolOneKey")
        );
    }

    #[tokio::test]
    async fn pool_info_rejects_an_unrelated_contract_id() {
        let fixture = pool_responses();
        let (base_url, requests) =
            mock_api_sequence(vec![(200, fixture.info), (200, fixture.current_raw)]);
        let unrelated_contract_id = Txid::from_str(&"44".repeat(32)).unwrap();

        let error = crate::ApiClient::with_base_url(base_url)
            .fetch_pool_nft_info(&unrelated_contract_id)
            .await
            .unwrap_err();
        requests.join().unwrap();

        assert!(matches!(error, Error::Api(message) if message.contains("contract")));
    }

    #[tokio::test]
    async fn pool_info_rejects_creation_input_that_mismatches_the_embedded_source() {
        let mut fixture = pool_responses();
        let mut transaction = contract_transaction(&fixture);
        transaction.inputs[0].previous_output.vout += 1;
        replace_contract_transaction(&mut fixture, &transaction);
        let (base_url, requests) =
            mock_api_sequence(vec![(200, fixture.info), (200, fixture.contract_raw)]);

        let error = crate::ApiClient::with_base_url(base_url)
            .fetch_pool_nft_info(&fixture.contract_id)
            .await
            .unwrap_err();
        let requests = requests.join().unwrap();

        assert!(matches!(error, Error::Api(message) if message.contains("source outpoint")));
        assert_eq!(requests.len(), 2);
    }

    #[tokio::test]
    async fn pool_info_rejects_creation_with_an_extra_input() {
        let mut fixture = pool_responses();
        let mut transaction = contract_transaction(&fixture);
        transaction.inputs.push(TxIn::new(OutPoint {
            txid: Txid::from_le_bytes([0x44; 32]),
            vout: 1,
        }));
        replace_contract_transaction(&mut fixture, &transaction);
        let (base_url, requests) =
            mock_api_sequence(vec![(200, fixture.info), (200, fixture.contract_raw)]);

        let error = crate::ApiClient::with_base_url(base_url)
            .fetch_pool_nft_info(&fixture.contract_id)
            .await
            .unwrap_err();
        let requests = requests.join().unwrap();

        assert!(matches!(error, Error::Api(message) if message.contains("exactly one input")));
        assert_eq!(requests.len(), 2);
    }

    #[tokio::test]
    async fn pool_info_rejects_missing_or_misplaced_creation_outputs() {
        let mut fixture = pool_responses();
        let mut transaction = contract_transaction(&fixture);
        transaction.outputs.clear();
        replace_contract_transaction(&mut fixture, &transaction);
        let (base_url, requests) =
            mock_api_sequence(vec![(200, fixture.info), (200, fixture.contract_raw)]);
        let error = crate::ApiClient::with_base_url(base_url)
            .fetch_pool_nft_info(&fixture.contract_id)
            .await
            .unwrap_err();
        requests.join().unwrap();
        assert!(matches!(error, Error::Api(message) if message.contains("vout 0")));

        let mut fixture = pool_responses();
        let mut transaction = contract_transaction(&fixture);
        transaction.outputs.swap(0, 1);
        replace_contract_transaction(&mut fixture, &transaction);
        let (base_url, requests) =
            mock_api_sequence(vec![(200, fixture.info), (200, fixture.contract_raw)]);
        let error = crate::ApiClient::with_base_url(base_url)
            .fetch_pool_nft_info(&fixture.contract_id)
            .await
            .unwrap_err();
        requests.join().unwrap();
        assert!(matches!(error, Error::Api(message) if message.contains("vout 0")));

        let mut fixture = pool_responses();
        let mut transaction = contract_transaction(&fixture);
        transaction.outputs.truncate(1);
        replace_contract_transaction(&mut fixture, &transaction);
        let (base_url, requests) =
            mock_api_sequence(vec![(200, fixture.info), (200, fixture.contract_raw)]);
        let error = crate::ApiClient::with_base_url(base_url)
            .fetch_pool_nft_info(&fixture.contract_id)
            .await
            .unwrap_err();
        requests.join().unwrap();
        assert!(matches!(error, Error::Api(message) if message.contains("vout 1")));
    }

    #[tokio::test]
    async fn pool_info_rejects_a_nonzero_current_vout_before_fetching_raw_tx() {
        let fixture = pool_responses();
        let mut info: serde_json::Value = serde_json::from_str(&fixture.info).unwrap();
        info["data"]["vout"] = serde_json::json!(1);
        let (base_url, requests) =
            mock_api_sequence(vec![(200, serde_json::to_string(&info).unwrap())]);

        let error = crate::ApiClient::with_base_url(base_url)
            .fetch_pool_nft_info(&fixture.contract_id)
            .await
            .unwrap_err();
        let requests = requests.join().unwrap();

        assert!(matches!(error, Error::Api(message) if message.contains("vout 0")));
        assert_eq!(requests.len(), 1);
    }

    #[tokio::test]
    async fn pool_info_rejects_a_non_v2_pool_code_marker() {
        let fixture = pool_responses();
        let mut info: serde_json::Value = serde_json::from_str(&fixture.info).unwrap();
        let mut raw: serde_json::Value = serde_json::from_str(&fixture.current_raw).unwrap();
        let mut transaction =
            Transaction::from_hex(raw["data"]["txraw"].as_str().unwrap()).unwrap();
        let mut code = transaction.outputs[0].script_pubkey.clone().into_bytes();
        let marker_offset = code.len() - b"2Code".len();
        code[marker_offset] = b'1';
        transaction.outputs[0].script_pubkey = Script::from_bytes(code);
        replace_current_transaction(&mut info, &mut raw, &transaction);
        let (base_url, requests) =
            mock_api_sequence(vec![(200, serde_json::to_string(&info).unwrap())]);

        let error = crate::ApiClient::with_base_url(base_url)
            .fetch_pool_nft_info(&fixture.contract_id)
            .await
            .unwrap_err();
        requests.join().unwrap();

        assert!(matches!(error, Error::Api(message) if message.contains("2Code")));
    }

    #[tokio::test]
    async fn pool_info_rejects_a_nonzero_ntape_output() {
        let fixture = pool_responses();
        let mut info: serde_json::Value = serde_json::from_str(&fixture.info).unwrap();
        let mut raw: serde_json::Value = serde_json::from_str(&fixture.current_raw).unwrap();
        let mut transaction =
            Transaction::from_hex(raw["data"]["txraw"].as_str().unwrap()).unwrap();
        transaction.outputs[1].satoshis = 1;
        replace_current_transaction(&mut info, &mut raw, &transaction);
        let (base_url, requests) = mock_api_sequence(vec![
            (200, serde_json::to_string(&info).unwrap()),
            (200, fixture.contract_raw),
            (200, serde_json::to_string(&raw).unwrap()),
        ]);

        let error = crate::ApiClient::with_base_url(base_url)
            .fetch_pool_nft_info(&fixture.contract_id)
            .await
            .unwrap_err();
        requests.join().unwrap();

        assert!(matches!(error, Error::Api(message) if message.contains("zero satoshis")));
    }

    #[tokio::test]
    async fn pool_info_rejects_current_value_below_code_plus_tbc_reserve() {
        let fixture = pool_responses();
        let mut info: serde_json::Value = serde_json::from_str(&fixture.info).unwrap();
        let mut raw: serde_json::Value = serde_json::from_str(&fixture.current_raw).unwrap();
        let mut transaction =
            Transaction::from_hex(raw["data"]["txraw"].as_str().unwrap()).unwrap();
        transaction.outputs[0].satoshis -= 1;
        replace_current_transaction(&mut info, &mut raw, &transaction);
        let (base_url, requests) = mock_api_sequence(vec![
            (200, serde_json::to_string(&info).unwrap()),
            (200, fixture.contract_raw),
            (200, serde_json::to_string(&raw).unwrap()),
        ]);

        let error = crate::ApiClient::with_base_url(base_url)
            .fetch_pool_nft_info(&fixture.contract_id)
            .await
            .unwrap_err();
        requests.join().unwrap();

        assert!(matches!(error, Error::Api(message) if message.contains("Pool Code value")));
    }

    #[tokio::test]
    async fn pool_info_accepts_retained_fee_value_above_tape_reserve_for_both_swap_directions() {
        // Released fee-bearing swaps retain an LP fee (TBC -> FT) or a
        // rounding/service remainder (FT -> TBC) in Pool Code.  Bind each
        // indexer response to the exact current Code/Tape raw transaction.
        for retained_fee in [2_500u64, 1u64] {
            let fixture = pool_responses();
            let mut info: serde_json::Value = serde_json::from_str(&fixture.info).unwrap();
            let mut raw: serde_json::Value = serde_json::from_str(&fixture.current_raw).unwrap();
            let mut transaction = current_transaction(&fixture);
            transaction.outputs[0].satoshis += retained_fee;
            replace_current_transaction(&mut info, &mut raw, &transaction);
            let (base_url, requests) = mock_api_sequence(vec![
                (200, serde_json::to_string(&info).unwrap()),
                (200, fixture.contract_raw),
                (200, serde_json::to_string(&raw).unwrap()),
            ]);

            let loaded = crate::ApiClient::with_base_url(base_url)
                .fetch_pool_nft_info(&fixture.contract_id)
                .await
                .unwrap();
            requests.join().unwrap();
            assert_eq!(loaded.current_utxo.satoshis, 4_000 + retained_fee);
            assert_eq!(loaded.state.amounts.tbc_sat, 3_000);
        }
    }

    #[tokio::test]
    async fn pool_info_rejects_current_pool_code_value_overflow() {
        let fixture = pool_responses();
        let mut info: serde_json::Value = serde_json::from_str(&fixture.info).unwrap();
        let mut raw: serde_json::Value = serde_json::from_str(&fixture.current_raw).unwrap();
        let mut transaction =
            Transaction::from_hex(raw["data"]["txraw"].as_str().unwrap()).unwrap();
        let state = PoolState {
            amounts: PoolAmounts {
                ft_lp_raw: 1_000,
                ft_a_raw: 2_000,
                tbc_sat: u64::MAX,
            },
            ft_lp_partial_hash: vec![0x11; 32],
            ft_a_partial_hash: vec![0x22; 32],
            ft_a_contract_id: Txid::from_str(&"33".repeat(32)).unwrap(),
            service_fee_rate: 35,
            service_provider: "fixture-provider".to_string(),
            lp_plan: 2,
            public_key_locked: true,
            ftlp_lock_time_enabled: true,
        };
        transaction.outputs[0].satoshis = u64::MAX;
        transaction.outputs[1].script_pubkey = pool_tape(&state).unwrap();
        replace_current_transaction(&mut info, &mut raw, &transaction);
        info["data"]["tbc_balance"] = serde_json::json!(u64::MAX.to_string());
        let (base_url, requests) = mock_api_sequence(vec![
            (200, serde_json::to_string(&info).unwrap()),
            (200, fixture.contract_raw),
            (200, serde_json::to_string(&raw).unwrap()),
        ]);

        let error = crate::ApiClient::with_base_url(base_url)
            .fetch_pool_nft_info(&fixture.contract_id)
            .await
            .unwrap_err();
        requests.join().unwrap();

        assert!(matches!(error, Error::Api(message) if message.contains("overflow")));
    }

    #[tokio::test]
    async fn pool_info_rejects_lock_flag_that_disagrees_with_released_length_discriminator() {
        let mut fixture = pool_responses();
        let mut info: serde_json::Value = serde_json::from_str(&fixture.info).unwrap();
        let mut raw: serde_json::Value = serde_json::from_str(&fixture.current_raw).unwrap();
        let mut transaction =
            Transaction::from_hex(raw["data"]["txraw"].as_str().unwrap()).unwrap();
        transaction.outputs[0].script_pubkey = released_pool_code("standardPool");
        replace_current_transaction(&mut info, &mut raw, &transaction);

        let mut contract_tx = contract_transaction(&fixture);
        contract_tx.outputs[0].script_pubkey = released_pool_code("standardPool");
        replace_contract_transaction(&mut fixture, &contract_tx);
        let (base_url, requests) = mock_api_sequence(vec![
            (200, serde_json::to_string(&info).unwrap()),
            (200, fixture.contract_raw),
            (200, serde_json::to_string(&raw).unwrap()),
        ]);

        let error = crate::ApiClient::with_base_url(base_url)
            .fetch_pool_nft_info(&fixture.contract_id)
            .await
            .unwrap_err();
        requests.join().unwrap();

        assert!(matches!(error, Error::Api(message) if message.contains("lock flag")));
    }

    #[tokio::test]
    async fn pool_utxo_is_the_verified_current_pool_output() {
        let fixture = pool_responses();
        let (base_url, requests) = mock_api_sequence(vec![
            (200, fixture.info),
            (200, fixture.contract_raw),
            (200, fixture.current_raw),
        ]);

        let utxo = crate::ApiClient::with_base_url(base_url)
            .fetch_pool_nft_utxo(&fixture.contract_id)
            .await
            .unwrap();
        requests.join().unwrap();

        assert_eq!(utxo.outpoint.txid, fixture.current_txid);
        assert_eq!(utxo.outpoint.vout, 0);
        assert_eq!(utxo.satoshis, 4_000);
    }

    #[tokio::test]
    async fn pool_info_rejects_non_v2_and_endpoint_tape_mismatch() {
        let fixture = pool_responses();
        let mut info = fixture.info;
        let mut value: serde_json::Value = serde_json::from_str(&info).unwrap();
        value["data"]["version"] = serde_json::json!(1);
        info = value.to_string();
        let (base_url, requests) = mock_api_sequence(vec![(200, info)]);
        let error = crate::ApiClient::with_base_url(base_url)
            .fetch_pool_nft_info(&fixture.contract_id)
            .await
            .unwrap_err();
        requests.join().unwrap();
        assert!(matches!(error, Error::Api(message) if message.contains("version")));

        let fixture = pool_responses();
        let mut value: serde_json::Value = serde_json::from_str(&fixture.info).unwrap();
        value["data"]["lp_balance"] = serde_json::json!(1001);
        let (base_url, requests) = mock_api_sequence(vec![
            (200, value.to_string()),
            (200, fixture.contract_raw),
            (200, fixture.current_raw),
        ]);
        let error = crate::ApiClient::with_base_url(base_url)
            .fetch_pool_nft_info(&fixture.contract_id)
            .await
            .unwrap_err();
        requests.join().unwrap();
        assert!(matches!(error, Error::Api(message) if message.contains("does not match")));
    }

    #[tokio::test]
    async fn pool_info_rejects_negative_fractional_and_overflow_integers() {
        for invalid in [
            serde_json::json!(-1),
            serde_json::json!(1.5),
            serde_json::json!("340282366920938463463374607431768211456"),
        ] {
            let fixture = pool_responses();
            let mut value: serde_json::Value = serde_json::from_str(&fixture.info).unwrap();
            value["data"]["lp_balance"] = invalid;
            let (base_url, requests) = mock_api_sequence(vec![(200, value.to_string())]);
            let error = crate::ApiClient::with_base_url(base_url)
                .fetch_pool_nft_info(&fixture.contract_id)
                .await
                .unwrap_err();
            requests.join().unwrap();
            assert!(matches!(error, Error::Json(_) | Error::Api(_)));
        }
    }

    #[tokio::test]
    async fn ftlp_utxos_decode_reversed_sha256_and_normalize_balances() {
        let locking_script = Script::from_bytes(vec![0x51]);
        let body = ftlp_response(serde_json::json!([
            {
                "txid": "01".repeat(32),
                "index": "2",
                "tbc_balance": 500,
                "decimal": "6",
                "lp_balance": "500"
            },
            {
                "txid": "02".repeat(32),
                "index": 3,
                "tbc_balance": "501",
                "decimal": 6,
                "lp_balance": 600
            }
        ]));
        let (base_url, requests) = mock_api_sequence(vec![(200, body)]);

        let utxos = crate::ApiClient::with_base_url(base_url)
            .fetch_ftlp_utxos(&locking_script)
            .await
            .unwrap();
        let requests = requests.join().unwrap();

        assert!(requests[0].starts_with(
            "GET /api/tbc/pool/lputxo/scriptpubkeyhash/6032c38c0bc0e91e726f1e55e1832e434509001a7aed5cfd881b6ef07215e84a "
        ));
        assert_eq!(utxos.len(), 2);
        assert_eq!(utxos[0].base.outpoint.vout, 2);
        assert_eq!(utxos[0].base.satoshis, 500);
        assert_eq!(utxos[0].base.script_pubkey, locking_script);
        assert_eq!(utxos[0].ft_balance_raw, 500);
        assert_eq!(utxos[1].ft_balance_raw, 600);
    }

    #[tokio::test]
    async fn ftlp_empty_list_has_zero_balance_and_no_selectable_utxo() {
        let script = Script::from_bytes(vec![0x51]);
        let body = ftlp_response(serde_json::json!([]));
        let (base_url, requests) = mock_api_sequence(vec![(200, body)]);
        let utxos = crate::ApiClient::with_base_url(base_url)
            .fetch_ftlp_utxos(&script)
            .await
            .unwrap();
        requests.join().unwrap();
        assert!(utxos.is_empty());

        let body = ftlp_response(serde_json::json!([]));
        let (base_url, requests) = mock_api_sequence(vec![(200, body)]);
        let balance = crate::ApiClient::with_base_url(base_url)
            .fetch_ftlp_balance(&script)
            .await
            .unwrap();
        requests.join().unwrap();
        assert_eq!(balance, 0);

        let body = ftlp_response(serde_json::json!([]));
        let (base_url, requests) = mock_api_sequence(vec![(200, body)]);
        let error = crate::ApiClient::with_base_url(base_url)
            .fetch_ftlp_utxo_for_amount(&script, 1)
            .await
            .unwrap_err();
        requests.join().unwrap();
        assert!(matches!(error, Error::Api(message) if message.contains("insufficient")));
    }

    #[tokio::test]
    async fn ftlp_null_utxos_are_empty_with_zero_balance_and_no_selection() {
        let script = Script::from_bytes(vec![0x51]);
        let body = ftlp_response(serde_json::Value::Null);
        let (base_url, requests) = mock_api_sequence(vec![(200, body)]);
        let utxos = crate::ApiClient::with_base_url(base_url)
            .fetch_ftlp_utxos(&script)
            .await
            .unwrap();
        requests.join().unwrap();
        assert!(utxos.is_empty());

        let body = ftlp_response(serde_json::Value::Null);
        let (base_url, requests) = mock_api_sequence(vec![(200, body)]);
        let balance = crate::ApiClient::with_base_url(base_url)
            .fetch_ftlp_balance(&script)
            .await
            .unwrap();
        requests.join().unwrap();
        assert_eq!(balance, 0);

        let body = ftlp_response(serde_json::Value::Null);
        let (base_url, requests) = mock_api_sequence(vec![(200, body)]);
        let error = crate::ApiClient::with_base_url(base_url)
            .fetch_ftlp_utxo_for_amount(&script, 1)
            .await
            .unwrap_err();
        requests.join().unwrap();
        assert!(matches!(error, Error::Api(message) if message.contains("insufficient")));
    }

    #[tokio::test]
    async fn ftlp_empty_list_rejects_amount_zero_as_insufficient() {
        let script = Script::from_bytes(vec![0x51]);
        let body = ftlp_response(serde_json::json!([]));
        let (base_url, requests) = mock_api_sequence(vec![(200, body)]);

        let error = crate::ApiClient::with_base_url(base_url)
            .fetch_ftlp_utxo_for_amount(&script, 0)
            .await
            .unwrap_err();
        requests.join().unwrap();

        assert!(matches!(error, Error::Api(message) if message.contains("insufficient")));
    }

    #[tokio::test]
    async fn ftlp_selection_distinguishes_single_merge_and_insufficient_amounts() {
        let script = Script::from_bytes(vec![0x51]);
        let entries = serde_json::json!([
            {"txid": "01".repeat(32), "index": 0, "tbc_balance": 500, "decimal": 6, "lp_balance": 400},
            {"txid": "02".repeat(32), "index": 1, "tbc_balance": 500, "decimal": 6, "lp_balance": "700"}
        ]);

        let (base_url, requests) = mock_api_sequence(vec![(200, ftlp_response(entries.clone()))]);
        let selected = crate::ApiClient::with_base_url(base_url)
            .fetch_ftlp_utxo_for_amount(&script, 600)
            .await
            .unwrap();
        requests.join().unwrap();
        assert_eq!(selected.base.outpoint.vout, 1);

        let (base_url, requests) = mock_api_sequence(vec![(200, ftlp_response(entries.clone()))]);
        let error = crate::ApiClient::with_base_url(base_url)
            .fetch_ftlp_utxo_for_amount(&script, 1_000)
            .await
            .unwrap_err();
        requests.join().unwrap();
        assert!(matches!(error, Error::Api(message) if message.contains("merge")));

        let (base_url, requests) = mock_api_sequence(vec![(200, ftlp_response(entries))]);
        let error = crate::ApiClient::with_base_url(base_url)
            .fetch_ftlp_utxo_for_amount(&script, 1_200)
            .await
            .unwrap_err();
        requests.join().unwrap();
        assert!(matches!(error, Error::Api(message) if message.contains("insufficient")));
    }

    #[tokio::test]
    async fn ftlp_rejects_malformed_integer_fields_and_balance_overflow() {
        let script = Script::from_bytes(vec![0x51]);
        for invalid in [
            serde_json::json!(-1),
            serde_json::json!(0.5),
            serde_json::json!("nope"),
        ] {
            let entries = serde_json::json!([{
                "txid": "01".repeat(32), "index": 0, "tbc_balance": 500,
                "decimal": 6, "lp_balance": invalid
            }]);
            let (base_url, requests) = mock_api_sequence(vec![(200, ftlp_response(entries))]);
            let error = crate::ApiClient::with_base_url(base_url)
                .fetch_ftlp_utxos(&script)
                .await
                .unwrap_err();
            requests.join().unwrap();
            assert!(matches!(error, Error::Json(_) | Error::Api(_)));
        }

        let entries = serde_json::json!([
            {"txid": "01".repeat(32), "index": 0, "tbc_balance": 500, "decimal": 6, "lp_balance": u128::MAX.to_string()},
            {"txid": "02".repeat(32), "index": 1, "tbc_balance": 500, "decimal": 6, "lp_balance": "1"}
        ]);
        let (base_url, requests) = mock_api_sequence(vec![(200, ftlp_response(entries))]);
        let error = crate::ApiClient::with_base_url(base_url)
            .fetch_ftlp_balance(&script)
            .await
            .unwrap_err();
        requests.join().unwrap();
        assert!(matches!(error, Error::Api(message) if message.contains("overflow")));
    }

    #[tokio::test]
    async fn ftlp_rejects_non_success_api_code_even_when_data_is_present() {
        let script = Script::from_bytes(vec![0x51]);
        let body = serde_json::json!({
            "code": "500",
            "message": "index unavailable",
            "data": {"utxos": []}
        })
        .to_string();
        let (base_url, requests) = mock_api_sequence(vec![(200, body)]);
        let error = crate::ApiClient::with_base_url(base_url)
            .fetch_ftlp_utxos(&script)
            .await
            .unwrap_err();
        requests.join().unwrap();
        assert!(matches!(error, Error::Api(message) if message.contains("index unavailable")));
    }

    #[tokio::test]
    async fn ftlp_get_retries_only_502_503_504_and_is_bounded() {
        let script = Script::from_bytes(vec![0x51]);
        let success = ftlp_response(serde_json::json!([]));
        let (base_url, requests) = mock_api_sequence(vec![
            (502, "{}".to_string()),
            (503, "{}".to_string()),
            (504, "{}".to_string()),
            (200, success),
        ]);
        let result = crate::ApiClient::with_base_url(base_url)
            .fetch_ftlp_utxos(&script)
            .await
            .unwrap();
        assert!(result.is_empty());
        assert_eq!(requests.join().unwrap().len(), 4);

        let (base_url, requests) = mock_api_sequence(vec![(500, "{}".to_string())]);
        let error = crate::ApiClient::with_base_url(base_url)
            .fetch_ftlp_utxos(&script)
            .await
            .unwrap_err();
        assert!(matches!(error, Error::Api(message) if message.contains("500")));
        assert_eq!(requests.join().unwrap().len(), 1);

        let (base_url, requests) = mock_api_sequence(vec![
            (503, "{}".to_string()),
            (503, "{}".to_string()),
            (503, "{}".to_string()),
            (503, "{}".to_string()),
        ]);
        let error = crate::ApiClient::with_base_url(base_url)
            .fetch_ftlp_utxos(&script)
            .await
            .unwrap_err();
        assert!(matches!(error, Error::Api(message) if message.contains("503")));
        assert_eq!(requests.join().unwrap().len(), 4);
    }

    #[tokio::test]
    async fn broadcast_post_does_not_retry_retryable_get_statuses() {
        let (base_url, requests) = mock_api_sequence(vec![(503, "{}".to_string())]);
        let error = crate::ApiClient::with_base_url(base_url)
            .broadcast_raw_transaction("00")
            .await
            .unwrap_err();
        let requests = requests.join().unwrap();
        assert!(matches!(error, Error::BroadcastFailure(_)));
        assert_eq!(requests.len(), 1);
        assert!(requests[0].starts_with("POST /api/tbc/broadcasttx "));
    }
}
