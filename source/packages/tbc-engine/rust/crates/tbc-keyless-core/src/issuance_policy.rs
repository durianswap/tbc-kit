//! Bounded wire adapter to the shared policy, not a second asset algorithm.
//! All prevout provenance, freshness, approval and signing remain the caller's
//! responsibility. Never log requests: signed associated parents can be sensitive.
use serde::Deserialize;
use serde_json::{Value, json};
use tbc_engine_core::protocols::{historical_policy::*, historical_pool::*};
use tbc_sdk::{Address, OutPoint, PublicKey, Transaction, TxOut, Txid, script::Script,
    contracts::pool_nft_v2::FtScriptVersion};

#[derive(Deserialize)]
#[serde(rename_all="camelCase", deny_unknown_fields)]
pub(crate) struct PolicyTransaction {
    raw_transaction:String,
    #[serde(default)] input_templates:Vec<InputTemplate>,
    #[serde(default)] output_templates:Vec<OutputTemplate>,
}
#[derive(Clone, Deserialize)]
#[serde(rename_all="camelCase", deny_unknown_fields)]
pub(crate) struct ResolvedOutput {txid:String, vout:u32, satoshis:String, script_pub_key:String}
impl ResolvedOutput {
    pub(crate) fn decode(self)->Result<(OutPoint,TxOut),String> {
        Ok((point(&self.txid,self.vout)?,TxOut{satoshis:amount(&self.satoshis)?,
            script_pubkey:Script::from_bytes(bytes(&self.script_pub_key,65_536)?)}))
    }
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct InputTemplate {txid:String, vout:u32, template:Template}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct OutputTemplate {vout:u32, template:Template}
#[derive(Deserialize)]
#[serde(tag="kind", rename_all="camelCase", rename_all_fields="camelCase", deny_unknown_fields)]
enum Template {
    Pool {ft_version:u8, is_coin:bool, tag:String, #[serde(default)] lock:Option<Lock>},
    Ftlp {pool_code_hash:String, ft_version:u8, is_coin:bool, lock_time_enabled:bool},
}
#[derive(Deserialize)]
#[serde(rename_all="camelCase", deny_unknown_fields)]
struct Lock {public_keys:Vec<String>, lp_cost_address:String, lp_cost_sat:String}

fn bytes(text:&str,max:usize)->Result<Vec<u8>,String> {
    if text.len()>2*max {return Err("Policy material exceeds byte bound".into());}
    let bytes=hex::decode(text).map_err(|_|"Policy material hex is invalid")?;
    if hex::encode(&bytes)!=text {return Err("Policy material hex is not canonical".into());}
    Ok(bytes)
}
fn point(txid:&str,vout:u32)->Result<OutPoint,String> {
    if bytes(txid,32)?.len()!=32 {return Err("Policy transaction ID length is invalid".into());}
    Ok(OutPoint{txid:txid.parse::<Txid>().map_err(|_|"Policy transaction ID is invalid")?,vout})
}
fn amount(text:&str)->Result<u64,String> {
    if text.is_empty() || text.len()>20 || !text.bytes().all(|b|b.is_ascii_digit())
        || (text.len()>1 && text.starts_with('0')) {return Err("Policy amount is not canonical".into());}
    text.parse().map_err(|_|"Policy amount exceeds bound".into())
}
fn version(value:u8)->Result<FtScriptVersion,String> {
    match value {1=>Ok(FtScriptVersion::V1),2=>Ok(FtScriptVersion::V2),3=>Ok(FtScriptVersion::V3),4=>Ok(FtScriptVersion::V4),
        _=>Err("Unsupported historical template version".into())}
}
impl Template {
    fn decode(self)->Result<HistoricalTemplate,String> {
        Ok(match self {
            Self::Pool{ft_version,is_coin,tag,lock}=>HistoricalTemplate::Pool(HistoricalPoolTemplate{
                ft_version:version(ft_version)?,is_coin,tag:bytes(&tag,75)?,lock:lock.map(|lock| -> Result<HistoricalPoolLockTemplate,String> {
                    if lock.public_keys.is_empty() || lock.public_keys.len()>10 {return Err("Policy controller count exceeds bound".into());}
                    let public_keys=lock.public_keys.iter().map(|key| {
                        let raw=bytes(key,65)?;
                        PublicKey::from_slice(&raw).map_err(|_|"Policy controller key is invalid".into())
                    }).collect::<Result<Vec<_>,String>>()?;
                    let lp_cost_address=Address::from_string(&lock.lp_cost_address).map_err(|_|"Policy LP cost address is invalid")?;
                    Ok(HistoricalPoolLockTemplate{public_keys,lp_cost_address,lp_cost_sat:amount(&lock.lp_cost_sat)?})
                }).transpose()?,
            }),
            Self::Ftlp{pool_code_hash,ft_version,is_coin,lock_time_enabled}=>HistoricalTemplate::Ftlp(HistoricalFtlpTemplate{
                pool_code_hash:bytes(&pool_code_hash,32)?.try_into().map_err(|_|"Policy pool hash length is invalid")?,
                ft_version:version(ft_version)?,is_coin,lock_time_enabled,
            }),
        })
    }
}

pub(crate) fn check(transactions:Vec<PolicyTransaction>,resolved:Vec<ResolvedOutput>)->Result<Value,String> {
    if transactions.is_empty() || transactions.len()>33 || resolved.len()>10_000 {
        return Err("Policy batch count exceeds bound".into());
    }
    let mut parsed=Vec::with_capacity(transactions.len());
    let mut input_hints=Vec::with_capacity(transactions.len());
    let mut output_hints=Vec::with_capacity(transactions.len());
    let mut total_inputs=0usize;let mut total_outputs=0usize;
    for item in transactions {
        let raw=bytes(&item.raw_transaction,1_048_576)?;
        let tx=Transaction::from_bytes(&raw).map_err(|_|"Policy transaction is invalid")?;
        if tx.serialize()!=raw || tx.inputs.is_empty() || tx.outputs.is_empty() {
            return Err("Policy transaction is not canonical or is empty".into());
        }
        total_inputs+=tx.inputs.len();total_outputs+=tx.outputs.len();
        if total_inputs>1000 || total_outputs>10_000 || item.input_templates.len()>tx.inputs.len()
            || item.output_templates.len()>tx.outputs.len() {return Err("Policy transaction item bound exceeded".into());}
        let mut inputs=Vec::with_capacity(item.input_templates.len());
        for hint in item.input_templates {
            let point=point(&hint.txid,hint.vout)?;
            if !tx.inputs.iter().any(|input|input.previous_output==point) {return Err("Policy input hint is not spent".into());}
            inputs.push((point,hint.template.decode()?));
        }
        let mut outputs=Vec::with_capacity(item.output_templates.len());
        for hint in item.output_templates {
            if hint.vout as usize>=tx.outputs.len() {return Err("Policy output hint is out of bounds".into());}
            outputs.push((hint.vout,hint.template.decode()?));
        }
        parsed.push(tx);input_hints.push(inputs);output_hints.push(outputs);
    }
    let mut points=Vec::with_capacity(resolved.len());let mut outputs=Vec::with_capacity(resolved.len());
    for output in resolved {
        points.push(point(&output.txid,output.vout)?);
        outputs.push(TxOut{satoshis:amount(&output.satoshis)?,script_pubkey:Script::from_bytes(bytes(&output.script_pub_key,65_536)?)});
    }
    let material=points.into_iter().zip(outputs.iter()).map(|(outpoint,output)|ResolvedHistoricalOutput{outpoint,output}).collect::<Vec<_>>();
    let batch=parsed.iter().enumerate().map(|(index,transaction)|HistoricalPolicyTransaction{transaction,
        templates:HistoricalPolicyTemplates{inputs:&input_hints[index],outputs:&output_hints[index]}}).collect::<Vec<_>>();
    // Sanitized errors deliberately do not expose raw scripts, metadata, or any
    // unlocking data. Hints never override exact shared template reconstruction.
    require_batch_no_historical_issuance(&batch,&material).map_err(|_|"Historical issuance policy rejected the batch")?;
    Ok(json!({"verification":"historical-issuance-policy","assetIdentityVerified":false,
        "transactionIds":parsed.iter().map(|tx|tx.txid().to_string()).collect::<Vec<_>>()}))
}
