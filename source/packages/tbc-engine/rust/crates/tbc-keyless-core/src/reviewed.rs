//! Keyless Reviewed-transaction stages. Derivation/unlock layout extracted from
//! wallet-private-core; no private key, signing, network or approval lives here.
//! The caller binds the request to a reviewed approval and signs returned digests
//! with its custody adapter. Every supplied signature is verified at finalization.
use std::{collections::HashMap,str::FromStr};
use serde::{Deserialize,Serialize};
use k256::ecdsa::{Signature,VerifyingKey,signature::hazmat::PrehashVerifier};
use tbc_sdk::{DEFAULT_SIGHASH,OutPoint,Transaction,TxOut,Txid,script::Script,
 contracts::ft::unlock::{contract_tx_data,current_inputs_data,current_tx_data,pre_tx_data}};
mod current_token;
const MAX_REQUEST_BYTES:usize=4*1024*1024;
const MAX_TRANSACTIONS:usize=33;
const MAX_INPUTS:usize=1000;
#[derive(Clone, Copy, Deserialize, Serialize)]
#[serde(rename_all = "snake_case")]
enum AssociatedScriptType {
    P2pkh,
    Tbc20,
    Tbc20Contract,
    Tbc20Coin,
    Tbc20CoinContract,
    TbcLopMatch,
    #[serde(rename = "tbc20-standard")]
    CurrentTbc20,
    #[serde(rename = "tbc20-stablecoin")]
    CurrentCoin,
    Other,
}

#[derive(Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct AssociatedInput {
    tx_id: Option<String>,
    script: Option<String>,
    satoshis: Option<u64>,
    output_index: u32,
    script_sig_type: AssociatedScriptType,
    pre_tx: Option<String>,
    pre_pre_tx_data: Option<String>,
    contract_tx: Option<String>,
    ft_version: Option<u8>,
    unfinished_script_sig: Option<String>,
    /// Public direct ancestors for current covenant proof reconstruction only.
    /// Absent on existing profiles; never reinterpret old prePreTxData bytes.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    ancestor_transactions: Option<Vec<String>>,
    /// Explicit current Coin administrator key, authenticated against Code.
    /// This is public calculation material, not wallet account authorization.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    signing_public_key: Option<String>,
}

#[derive(Clone, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
struct AssociatedOutput {
    script: String,
    satoshis: u64,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct SignAssociatedRequest {
    source_txraw: String,
    source_utxos: Vec<AssociatedInput>,
    #[serde(default)]
    inputs: Vec<Vec<AssociatedInput>>,
    #[serde(default)]
    outputs: Vec<Vec<AssociatedOutput>>,
}


#[derive(Deserialize)]
#[serde(rename_all="camelCase",deny_unknown_fields)]
struct PrepareRequest {
    format:String, request:serde_json::Value, public_key:String,
    #[serde(default)] transaction_index:usize,
    #[serde(default)] previous_transactions:Vec<String>,
    /// Wallet-authenticated supplemental Tape/Hold material, bound alongside
    /// the request by the custody adapter. Primary input claims cannot be
    /// overridden; earlier local outputs are reconstructed from the batch.
    #[serde(default)] resolved_outputs:Vec<crate::issuance_policy::ResolvedOutput>,
}
#[derive(Deserialize)]
#[serde(rename_all="camelCase",deny_unknown_fields)]
struct RawRequest {
    txraws:Vec<String>,
    #[serde(alias="utxos_satoshis")] utxos_satoshis:Vec<Vec<u64>>,
    #[serde(alias="script_pubkeys")] script_pubkeys:Vec<Vec<String>>,
    /// Wallet-resolved public Coin administrator keys, not page authority.
    /// Null entries retain the primary signer. Optional for existing callers.
    #[serde(default)] signing_public_keys:Option<Vec<Vec<Option<String>>>>,
}
impl RawRequest {
 fn validate_signing_keys(&self)->Result<(),String>{
  if let Some(keys)=&self.signing_public_keys{
   if keys.len()!=self.txraws.len()||keys.iter().zip(&self.utxos_satoshis).any(|(k,v)|k.len()!=v.len()){
    return Err("Invalid raw signing key matrix".into());
   }
  }Ok(())
 }
}
#[derive(Serialize,Deserialize)]
#[serde(rename_all="camelCase",deny_unknown_fields)]
struct Stage { format:StageFormat, transaction_index:usize, txraw:String, public_key:String, inputs:Vec<AssociatedInput>, signing_input_indexes:Vec<usize>, digests:Vec<String>,
 #[serde(default,skip_serializing_if="Option::is_none")] signing_tasks:Option<Vec<SigningTask>> }
#[derive(Serialize,Deserialize,PartialEq,Eq)]
#[serde(rename_all="camelCase",deny_unknown_fields)]
struct SigningTask { input_index:usize, digest:String, public_key:String, algorithm:String }
#[derive(Clone,Copy,Serialize,Deserialize)]
#[serde(rename_all="lowercase")]
enum StageFormat { Raw, Associated }
#[derive(Deserialize)]
#[serde(rename_all="camelCase",deny_unknown_fields)]
struct FinalizeRequest { stage:Stage, signatures:Vec<String>, #[serde(default)] signature_encoding:Option<String> }
fn parse<T:for<'de>Deserialize<'de>>(s:&str)->Result<T,String>{
 if s.len()>MAX_REQUEST_BYTES{return Err("Reviewed material too large".into());}
 // Serde may embed an unknown field, enum or value from an unlocking
 // template. Diagnostics cross public bridges, so never echo caller data.
 serde_json::from_str(s).map_err(|_|"Invalid Reviewed request schema".to_owned())
}
fn key(s:&str)->Result<Vec<u8>,String>{
 let bytes=hex::decode(s).map_err(|e|e.to_string())?;
 if bytes.len()!=33{return Err("Compressed public key required".into());}
 VerifyingKey::from_sec1_bytes(&bytes).map_err(|e|e.to_string())?;Ok(bytes)
}
pub fn prepare(input:&str)->Result<String,String>{
 let request:PrepareRequest=parse(input)?;let public_key=key(&request.public_key)?;
 preflight_issuance(&request)?;
 let index=request.transaction_index;
 let format=match request.format.as_str(){"raw"=>StageFormat::Raw,"associated"=>StageFormat::Associated,_=>return Err("Unsupported Reviewed format".into())};
 let (transaction,inputs)=match format{
  StageFormat::Raw=>{
   let r:RawRequest=serde_json::from_value(request.request).map_err(|_|"Invalid Reviewed raw request schema".to_owned())?;
   if r.txraws.is_empty()||r.txraws.len()>MAX_TRANSACTIONS||r.txraws.len()!=r.utxos_satoshis.len()||r.txraws.len()!=r.script_pubkeys.len()||index>=r.txraws.len()||!request.previous_transactions.is_empty(){return Err("Invalid raw matrix".into());}
   r.validate_signing_keys()?;
   let tx=Transaction::from_hex(&r.txraws[index]).map_err(|e|e.to_string())?;
   if r.utxos_satoshis[index].len()!=tx.inputs.len()||r.script_pubkeys[index].len()!=tx.inputs.len(){return Err("Invalid raw input matrix".into());}
   let items=tx.inputs.iter().enumerate().map(|(i,txin)|{
    let signing_public_key=r.signing_public_keys.as_ref().and_then(|rows|rows[index][i].clone());
    AssociatedInput{tx_id:Some(txin.previous_output.txid.to_string()),output_index:txin.previous_output.vout,script:Some(r.script_pubkeys[index][i].clone()),satoshis:Some(r.utxos_satoshis[index][i]),
     script_sig_type:if signing_public_key.is_some(){AssociatedScriptType::CurrentCoin}else{AssociatedScriptType::P2pkh},
     pre_tx:None,pre_pre_tx_data:None,contract_tx:None,ft_version:None,unfinished_script_sig:None,ancestor_transactions:None,signing_public_key}
   }).collect();
   (tx,items)
  },
  StageFormat::Associated=>{
   let r:SignAssociatedRequest=serde_json::from_value(request.request).map_err(|_|"Invalid Reviewed associated request schema".to_owned())?;
   if r.inputs.len()!=r.outputs.len()||r.inputs.len()+1>MAX_TRANSACTIONS||index>r.inputs.len()||request.previous_transactions.len()!=index{return Err("Invalid associated stage".into());}
   reject_stablecoin(&r.source_utxos)?;for row in &r.inputs{reject_stablecoin(row)?;}
   if index==0{
    let tx=Transaction::from_hex(&r.source_txraw).map_err(|e|e.to_string())?;
    if tx.inputs.len()!=r.source_utxos.len(){return Err("Invalid source input matrix".into());}
    (tx,r.source_utxos)
   }else{
    let mut ancestry=HashMap::new();cache_pre_txs(&r.source_utxos,&mut ancestry)?;
    for row in &r.inputs{cache_pre_txs(row,&mut ancestry)?;}
    let mut previous=None;
    for raw in &request.previous_transactions{
     let tx=Transaction::from_hex(raw).map_err(|e|e.to_string())?;
     ancestry.insert(tx.txid().to_string(),tx.clone());previous=Some(tx);
    }
    let previous=previous.ok_or("Missing finalized parent")?;
    let mut tx=Transaction::new();let mut resolved=Vec::new();
    let (lock_time,sequences)=current_token::child_constraints(&r.inputs[index-1],&previous)?;
    tx.lock_time=lock_time;
    for (item,sequence) in r.inputs[index-1].iter().zip(sequences){
     let mut next=item.clone();
     if let Some(txid)=&item.tx_id{
      item.script.as_ref().ok_or("External script required")?;item.satoshis.ok_or("External amount required")?;
      tx.inputs.push(current_token::child_input(OutPoint{txid:Txid::from_str(txid).map_err(|e|e.to_string())?,vout:item.output_index},sequence));
     }else{
      let output=previous.outputs.get(item.output_index as usize).ok_or("Parent output out of range")?;
      tx.inputs.push(current_token::child_input(OutPoint{txid:previous.txid(),vout:item.output_index},sequence));
      next.tx_id=Some(previous.txid().to_string());next.script=Some(hex::encode(output.script_pubkey.as_bytes()));next.satoshis=Some(output.satoshis);
      if current_token::is_current(item.script_sig_type){
       if item.pre_tx.is_some(){return Err("Current associated local input must omit preTx".into());}
       next.pre_tx=Some(previous.to_hex());
       next.ancestor_transactions=Some(current_token::local_ancestors(&previous,item.output_index,item.script_sig_type,&ancestry)?);
      }
      if matches!(item.script_sig_type,AssociatedScriptType::TbcLopMatch){next.pre_tx=Some(previous.to_hex());}
      if matches!(item.script_sig_type,AssociatedScriptType::Tbc20|AssociatedScriptType::Tbc20Contract){
       next.pre_tx=Some(previous.to_hex());next.pre_pre_tx_data=Some(hex::encode(local_pre_pre_tx_data(&previous,item.output_index as usize,&ancestry)?));
      }
     }
     resolved.push(next);
    }
    for output in &r.outputs[index-1]{tx.outputs.push(TxOut{satoshis:output.satoshis,script_pubkey:parse_script(&output.script,"output script")?});}
    (tx,resolved)
   }
  },
 };
 if inputs.is_empty()||inputs.len()>MAX_INPUTS||inputs.len()!=transaction.inputs.len(){return Err("Invalid Reviewed input count".into());}
 let htlc_key=matches!(format,StageFormat::Associated).then_some(public_key.as_slice());
 let (signing_input_indexes,digests,current)=derive(&transaction,&inputs,htlc_key)?;
 let signing_tasks=signing_tasks(&inputs,&signing_input_indexes,&digests,&public_key,&current);
 // Validate signatureless covenants before any external signing is requested.
 permissionless_scripts(&transaction,&inputs)?;
 serde_json::to_string(&Stage{format,transaction_index:index,txraw:transaction.to_hex(),public_key:request.public_key,inputs,signing_input_indexes,digests,signing_tasks}).map_err(|e|e.to_string())
}
/// Check the whole concrete batch before releasing even the first digest.
/// Associated parents are replaced by their finalized bytes and checked against
/// the original requested shape on each stage, then children are reconstructed
/// with those actual parent IDs. No HTTP, keys, logging or persistence.
fn preflight_issuance(request:&PrepareRequest)->Result<(),String>{
 use tbc_engine_core::protocols::historical_policy::{HistoricalPolicyTransaction,HistoricalPolicyTemplates,ResolvedHistoricalOutput,require_batch_no_historical_issuance};
 type PointKey=([u8;32],u32);
 let mut material:HashMap<PointKey,TxOut>=HashMap::new();
 fn insert(map:&mut HashMap<([u8;32],u32),TxOut>,p:OutPoint,o:TxOut)->Result<(),String>{
  let k=(*p.txid.as_le_bytes(),p.vout);
  if let Some(old)=map.get(&k){if old!=&o{return Err("Reviewed policy material conflict".into());}}
  else{if map.len()>=10_000{return Err("Reviewed policy material bound exceeded".into());}map.insert(k,o);}
  Ok(())
 }
 fn transaction(raw:&str)->Result<Transaction,String>{
  if raw.len()>2_097_152{return Err("Reviewed policy transaction too large".into());}
  let tx=Transaction::from_hex(raw).map_err(|_|"Invalid Reviewed policy transaction")?;
  if tx.to_hex()!=raw.to_ascii_lowercase()||tx.inputs.is_empty()||tx.outputs.is_empty(){return Err("Invalid Reviewed policy transaction".into());}Ok(tx)
 }
 fn input_material(map:&mut HashMap<([u8;32],u32),TxOut>,tx:&Transaction,items:&[AssociatedInput])->Result<(),String>{
  if tx.inputs.len()!=items.len(){return Err("Reviewed policy input count mismatch".into());}
  for (input,item) in tx.inputs.iter().zip(items){
   if item.tx_id.as_deref()!=Some(input.previous_output.txid.to_string().as_str())||item.output_index!=input.previous_output.vout{return Err("Reviewed policy input identity mismatch".into());}
   insert(map,input.previous_output.clone(),TxOut{satoshis:item.satoshis.ok_or("Reviewed policy amount missing")?,
    script_pubkey:parse_script(item.script.as_ref().ok_or("Reviewed policy script missing")?,"policy input")?})?;
   if let Some(raw)=&item.pre_tx{
    let parent=transaction(raw)?;
    if parent.txid()!=input.previous_output.txid{return Err("Reviewed policy parent identity mismatch".into());}
    for (vout,output) in parent.outputs.into_iter().enumerate(){insert(map,OutPoint{txid:input.previous_output.txid,vout:vout as u32},output)?;}
   }
  }Ok(())
 }
 if request.resolved_outputs.len()>10_000{return Err("Reviewed policy material bound exceeded".into());}
 for output in request.resolved_outputs.clone(){let(p,o)=output.decode()?;insert(&mut material,p,o)?;}
 let mut txs:Vec<Transaction>=Vec::new();
 match request.format.as_str(){
  "raw"=>{
   let r:RawRequest=serde_json::from_value(request.request.clone()).map_err(|_|"Invalid Reviewed raw request schema")?;
   if r.txraws.is_empty()||r.txraws.len()>MAX_TRANSACTIONS||r.txraws.len()!=r.utxos_satoshis.len()||r.txraws.len()!=r.script_pubkeys.len()||request.transaction_index>=r.txraws.len()||!request.previous_transactions.is_empty(){return Err("Invalid raw policy matrix".into());}
   r.validate_signing_keys()?;
   for (index,raw) in r.txraws.iter().enumerate(){
    let tx=transaction(raw)?;
    if tx.inputs.len()!=r.utxos_satoshis[index].len()||tx.inputs.len()!=r.script_pubkeys[index].len(){return Err("Invalid raw policy input matrix".into());}
    for(i,input)in tx.inputs.iter().enumerate(){insert(&mut material,input.previous_output.clone(),TxOut{satoshis:r.utxos_satoshis[index][i],script_pubkey:parse_script(&r.script_pubkeys[index][i],"policy input")?})?;}
    txs.push(tx);
   }
  },
  "associated"=>{
   let r:SignAssociatedRequest=serde_json::from_value(request.request.clone()).map_err(|_|"Invalid Reviewed associated request schema")?;
   if r.inputs.len()!=r.outputs.len()||r.inputs.len()+1>MAX_TRANSACTIONS||request.transaction_index>r.inputs.len()||request.previous_transactions.len()!=request.transaction_index{return Err("Invalid associated policy matrix".into());}
   let source=transaction(&r.source_txraw)?;input_material(&mut material,&source,&r.source_utxos)?;
   txs.push(source);
   for index in 0..=r.inputs.len(){
    if let Some(raw)=request.previous_transactions.get(index){
     let finalized=transaction(raw)?;let mut shape=finalized.clone();
     if shape.inputs.len()!=txs[index].inputs.len(){return Err("Reviewed finalized parent shape mismatch".into());}
     for(input,expected)in shape.inputs.iter_mut().zip(&txs[index].inputs){input.script_sig=expected.script_sig.clone();}
     if shape.serialize()!=txs[index].serialize(){return Err("Reviewed finalized parent shape mismatch".into());}
     txs[index]=finalized;
    }
    if index==r.inputs.len(){break;}
    let parent=&txs[index];let parent_id=parent.txid();let mut tx=Transaction::new();let mut items=Vec::new();
    let (lock_time,sequences)=current_token::child_constraints(&r.inputs[index],parent)?;
    tx.lock_time=lock_time;
    for (item,sequence) in r.inputs[index].iter().zip(sequences){
     let mut next=item.clone();
     let point=if let Some(txid)=&item.tx_id {OutPoint{txid:txid.parse().map_err(|_|"Reviewed policy input ID invalid")?,vout:item.output_index}}
     else{
      let output=parent.outputs.get(item.output_index as usize).ok_or("Reviewed policy parent output missing")?;
      next.tx_id=Some(parent_id.to_string());next.script=Some(hex::encode(output.script_pubkey.as_bytes()));next.satoshis=Some(output.satoshis);
      // Local parent provenance comes from the reconstructed batch, not a
      // stale caller preTx containing a provisional parent ID.
      next.pre_tx=None;
      OutPoint{txid:parent_id,vout:item.output_index}
     };
     tx.inputs.push(current_token::child_input(point,sequence));items.push(next);
    }
    for output in &r.outputs[index]{tx.outputs.push(TxOut{satoshis:output.satoshis,script_pubkey:parse_script(&output.script,"policy output")?});}
    input_material(&mut material,&tx,&items)?;txs.push(tx);
   }
  },
  _=>return Err("Unsupported Reviewed format".into()),
 }
 if txs.iter().map(|tx|tx.inputs.len()).sum::<usize>()>MAX_INPUTS||txs.iter().map(|tx|tx.outputs.len()).sum::<usize>()>10_000{return Err("Reviewed policy batch bound exceeded".into());}
 let local:HashMap<_,_>=txs.iter().map(|tx|(*tx.txid().as_le_bytes(),tx)).collect();
 // Every local claim must match the actual output; omit only after comparison.
 for ((id,vout),output) in &material{if let Some(tx)=local.get(id){if tx.outputs.get(*vout as usize)!=Some(output){return Err("Reviewed local policy material mismatch".into());}}}
 let resolved=material.iter().filter(|((id,_),_)|!local.contains_key(id)).map(|((id,vout),output)|ResolvedHistoricalOutput{outpoint:OutPoint{txid:Txid::from_le_bytes(*id),vout:*vout},output}).collect::<Vec<_>>();
 let batch=txs.iter().map(|transaction|HistoricalPolicyTransaction{transaction,templates:HistoricalPolicyTemplates::default()}).collect::<Vec<_>>();
 require_batch_no_historical_issuance(&batch,&resolved).map_err(|_|"Reviewed historical issuance policy rejected the batch".into())
}
fn derive(tx:&Transaction,inputs:&[AssociatedInput],htlc_key:Option<&[u8]>)->Result<(Vec<usize>,Vec<String>,HashMap<usize,current_token::Prepared>),String>{
 let mut indexes=Vec::new();let mut digests=Vec::new();let mut current=HashMap::new();
 for (i,input) in inputs.iter().enumerate(){
  if input.signing_public_key.is_some()&&!matches!(input.script_sig_type,AssociatedScriptType::CurrentCoin){return Err("Explicit signing key requires current Coin administrator profile".into());}
  if input.ancestor_transactions.is_some()&&!current_token::is_current(input.script_sig_type){return Err("Current ancestor material requires a current signing profile".into());}
  if current_token::is_current(input.script_sig_type){
   if htlc_key.is_none(){
    // Raw returns detached signatures, not a reconstructed covenant witness.
    // Explicit alternate keys are restricted to the actual Coin Code admin.
    if !matches!(input.script_sig_type,AssociatedScriptType::CurrentCoin)||input.signing_public_key.is_none(){return Err("Raw current profile requires Coin administrator key".into());}
    let script=parse_script(input.script.as_ref().ok_or("Missing raw Coin script")?,"raw Coin script")?;
    let code=tbc_engine_core::protocols::coin::parse_code(script.as_bytes()).map_err(|_|"Raw administrator requires current Coin Code")?;
    current_token::administrator_key(input,&code)?.ok_or("Raw Coin administrator key missing")?;
    digests.push(hex::encode(tx.sighash_digest(i,&script,input.satoshis.ok_or("Missing raw Coin amount")?,DEFAULT_SIGHASH).map_err(|e|e.to_string())?));
    indexes.push(i);continue;
   }
   let prepared=current_token::prepare(tx,i,input,inputs,htlc_key.ok_or("Current profile requires associated format")?)?;
   digests.push(hex::encode(prepared.digest()));indexes.push(i);current.insert(i,prepared);continue;
  }
  if matches!(input.script_sig_type,AssociatedScriptType::TbcLopMatch){continue;}
  let script=parse_script(input.script.as_ref().ok_or("Missing script")?,"input script")?;
  if let Some(public_key)=htlc_key {
   // Reuse the already parsed prevout. Ordinary inputs get only the constant
   // template-length check; no extra parse, network query or script VM.
   if let Ok(code)=tbc_engine_core::protocols::htlc::Code::decode(script.as_bytes()) {
    validate_htlc_witness(tx,i,input,public_key,&code)?;
   }
   if let Ok(code)=tbc_engine_core::protocols::lop::Code::decode(script.as_bytes()) {
    validate_lop_cancel_witness(tx,i,input,public_key,&code)?;
   }
  }
  let amount=input.satoshis.ok_or("Missing amount")?;
  digests.push(tx.sighash_digest(i,&script,amount,DEFAULT_SIGHASH).map(hex::encode).map_err(|e|e.to_string())?);indexes.push(i);
}Ok((indexes,digests,current))
}
fn signing_tasks(inputs:&[AssociatedInput],indexes:&[usize],digests:&[String],default_key:&[u8],current:&HashMap<usize,current_token::Prepared>)->Option<Vec<SigningTask>>{
 if !inputs.iter().any(|i|i.signing_public_key.is_some()){return None;}
 Some(indexes.iter().zip(digests).map(|(&index,digest)|{
  let public_key=current.get(&index).map(|p|hex::encode(p.public_key()))
   .or_else(||inputs[index].signing_public_key.clone()).unwrap_or_else(||hex::encode(default_key));
  let algorithm=if public_key.len()==64{"secp256k1-schnorr"}else{"secp256k1-ecdsa"}.into();
  SigningTask{input_index:index,digest:digest.clone(),public_key,algorithm}
 }).collect())
}
pub fn finalize(input:&str)->Result<String,String>{
 let r:FinalizeRequest=parse(input)?;let stage=r.stage;
 let pubkey=key(&stage.public_key)?;let key=VerifyingKey::from_sec1_bytes(&pubkey).map_err(|e|e.to_string())?;
 let mut tx=Transaction::from_hex(&stage.txraw).map_err(|e|e.to_string())?;
 let htlc_key=matches!(stage.format,StageFormat::Associated).then_some(pubkey.as_slice());
 if stage.inputs.is_empty()||stage.inputs.len()>MAX_INPUTS||tx.inputs.len()!=stage.inputs.len()||r.signatures.len()!=stage.digests.len(){return Err("Reviewed stage mismatch".into());}
 let(indexes,digests,current)=derive(&tx,&stage.inputs,htlc_key)?;
 if indexes!=stage.signing_input_indexes||digests!=stage.digests{return Err("Reviewed stage mismatch".into());}
 if stage.signing_tasks!=signing_tasks(&stage.inputs,&indexes,&digests,&pubkey,&current){return Err("Reviewed signing task binding mismatch".into());}
 if matches!(stage.format,StageFormat::Raw)&&stage.signing_input_indexes.len()!=stage.inputs.len(){return Err("Raw signing requires every input".into());}
 let permissionless=permissionless_scripts(&tx,&stage.inputs)?;
 let mut verified_signatures=Vec::new();
 for (i,text) in r.signatures.iter().enumerate(){
  let bytes=hex::decode(text).map_err(|e|e.to_string())?;
  let input_index=stage.signing_input_indexes[i];
  if matches!(stage.format,StageFormat::Raw){
   if let Some(public_key)=&stage.inputs[input_index].signing_public_key{
    // Shared verification only: never put a synthesized script into raw.
    let public=hex::decode(public_key).map_err(|_|"Invalid raw administrator key")?;
    let key=tbc_engine_core::protocols::covenant_signature::CovenantPublicKey::parse(&public).map_err(|_|"Invalid raw administrator key")?;
    let wire=match r.signature_encoding.as_deref(){
     Some("compact64")=>{
      let mut wire=if public.len()==32{if bytes.len()!=64{return Err("Invalid raw Schnorr signature size".into());}bytes}
       else{Signature::from_slice(&bytes).map_err(|_|"Invalid raw ECDSA signature")?.to_der().as_bytes().to_vec()};
      wire.push(DEFAULT_SIGHASH as u8);wire
     },
     None|Some("der-sighash")=>bytes,
     _=>return Err("Unsupported signature encoding".into()),
    };
    let digest:[u8;32]=hex::decode(&stage.digests[i]).map_err(|_|"Invalid raw digest")?.try_into().map_err(|_|"Invalid raw digest")?;
    key.verify_transaction_signature(&digest,&wire).map_err(|_|"Raw Coin administrator signature mismatch")?;
    verified_signatures.push(hex::encode(wire));continue;
   }
  }
  if current.get(&input_index).is_some_and(|p|p.public_key().len()==32){
   // The same shared Coin proof verifies BIP340, sighash and witness binding.
   // Do not reinterpret Schnorr's 64 bytes as an ECDSA compact signature.
   let wire=match r.signature_encoding.as_deref(){
    Some("compact64") if bytes.len()==64=>{let mut wire=bytes;wire.push(DEFAULT_SIGHASH as u8);wire},
    None|Some("der-sighash") if bytes.len()==65&&bytes.last()==Some(&(DEFAULT_SIGHASH as u8))=>bytes,
    _=>return Err("Invalid Reviewed Schnorr signature encoding".into()),
   };
   tx.inputs[input_index].script_sig=current[&input_index].finalize(&wire)?;
   verified_signatures.push(hex::encode(wire));continue;
  }
  let signature=match r.signature_encoding.as_deref(){
   Some("compact64")=>Signature::from_slice(&bytes).map_err(|e|e.to_string())?,
   None|Some("der-sighash")=>{
    if bytes.last()!=Some(&(DEFAULT_SIGHASH as u8)){return Err("Reviewed sighash mismatch".into());}
    Signature::from_der(&bytes[..bytes.len()-1]).map_err(|e|e.to_string())?
   },
   _=>return Err("Unsupported signature encoding".into())
  };
  if signature.normalize_s().is_some(){return Err("Non-canonical signature".into());}
  let digest:[u8;32]=hex::decode(&stage.digests[i]).map_err(|e|e.to_string())?.try_into().map_err(|_|"Invalid digest")?;
  // The shared current proof's finalize validates this same key/digest and
  // canonical signature. Do not perform the expensive ECDSA check twice.
  if !current.contains_key(&input_index){key.verify_prehash(&digest,&signature).map_err(|_|"Reviewed signature mismatch")?;}
  let mut wire=signature.to_der().as_bytes().to_vec();wire.push(DEFAULT_SIGHASH as u8);
  // Raw requests promise detached input signatures. Their scripts may be new
  // Token/Coin/LOP covenants; synthesizing P2PKH unlocks would manufacture an
  // invalid "signed transaction". Only associated stages assemble witnesses.
  if matches!(stage.format,StageFormat::Associated){
   if let Some(prepared)=current.get(&input_index){tx.inputs[input_index].script_sig=prepared.finalize(&wire)?;}
   else{apply_associated_input(&mut tx,input_index,&stage.inputs[input_index],&pubkey,&wire)?;}
  }
  verified_signatures.push(hex::encode(wire));
 }
 for(index,script)in permissionless{tx.inputs[index].script_sig=script;}
 serde_json::to_string(&serde_json::json!({"txraw":tx.to_hex(),"txid":tx.txid().to_string(),"sigs":verified_signatures})).map_err(|e|e.to_string())
}
fn permissionless_scripts(tx:&Transaction,inputs:&[AssociatedInput])->Result<Vec<(usize,Script)>,String>{
 use tbc_engine_core::protocols::lop_proof::{build_match_unlock,build_match_unlock_pair};
 let mut parents=Vec::new();
 for(index,input)in inputs.iter().enumerate(){
  if !matches!(input.script_sig_type,AssociatedScriptType::TbcLopMatch){continue;}
  if input.unfinished_script_sig.is_some()||input.pre_pre_tx_data.is_some()||input.contract_tx.is_some()||input.ft_version.is_some(){return Err("LOP match input rejects arbitrary witness overrides".into());}
  let parent=Transaction::from_hex(input.pre_tx.as_ref().ok_or("LOP match parent required")?).map_err(|e|e.to_string())?;
  let current=tx.inputs.get(index).ok_or("LOP match input missing")?;
  let output=parent.outputs.get(input.output_index as usize).ok_or("LOP match parent output missing")?;
  if current.previous_output.txid!=parent.txid()||current.previous_output.vout!=input.output_index||input.tx_id.as_deref()!=Some(parent.txid().to_string().as_str())||input.satoshis!=Some(output.satoshis)||parse_script(input.script.as_ref().ok_or("LOP match script required")?,"LOP script")?!=output.script_pubkey{return Err("LOP match authenticated parent mismatch".into());}
  parents.push((index,parent));
 }
 if parents.len()==2&&parents[0].0==0&&parents[1].0==2{
  let [buy,sell]=build_match_unlock_pair(tx,&parents[0].1,&parents[1].1).map_err(|e|e.message)?;
  return Ok(vec![(0,buy),(2,sell)]);
 }
 parents.into_iter().map(|(i,p)|build_match_unlock(tx,&p,i).map(|s|(i,s)).map_err(|e|e.message)).collect()
}
fn reject_stablecoin(inputs:&[AssociatedInput])->Result<(),String>{
 if inputs.iter().any(|i|matches!(i.script_sig_type,AssociatedScriptType::Tbc20Coin|AssociatedScriptType::Tbc20CoinContract)){return Err("StableCoin associated signing is outside this capability".into());}Ok(())
}
// The owner branch is exactly signature + compressed public key + OP_2 in
// the pinned SDK. A caller cannot select the permissionless match branch by
// embedding a different template here; that branch has its own proof profile.
fn validate_lop_cancel_witness(tx:&Transaction,index:usize,input:&AssociatedInput,public_key:&[u8],
 code:&tbc_engine_core::protocols::lop::Code)->Result<(),String>{
 const ERROR:&str="Invalid associated LOP cancellation witness";
 let current=tx.inputs.get(index).ok_or(ERROR)?;
 if !matches!(input.script_sig_type,AssociatedScriptType::Other)||!current.script_sig.as_bytes().is_empty()
  ||input.tx_id.as_deref()!=Some(current.previous_output.txid.to_string().as_str())||input.output_index!=current.previous_output.vout
  ||tbc_sdk::hash::hash160(public_key)!=code.terms.owner_hash{return Err(ERROR.into());}
 let mut expected=b"\x09signature\x21".to_vec();expected.extend_from_slice(public_key);expected.push(0x52);
 let text=input.unfinished_script_sig.as_deref().ok_or(ERROR)?;
 if text.len()!=expected.len()*2||hex::decode(text).map_err(|_|ERROR)?!=expected{return Err(ERROR.into());}
 Ok(())
}
// Exact supported HTLC witness, not arbitrary Script execution or node finality.
// The approved request/Host binding remains required above this keyless layer.
// Both prepare and finalize call this; the witness is not part of the sighash.
fn validate_htlc_witness(tx:&Transaction,index:usize,input:&AssociatedInput,public_key:&[u8],
 code:&tbc_engine_core::protocols::htlc::Code)->Result<(),String>{
 const ERROR:&str="Invalid associated HTLC witness";
 use tbc_engine_core::protocols::htlc_transaction::MAX_PREIMAGE_BYTES;
 let current=&tx.inputs[index];
 if !matches!(input.script_sig_type,AssociatedScriptType::Other)||!current.script_sig.as_bytes().is_empty()
  ||input.tx_id.as_deref()!=Some(current.previous_output.txid.to_string().as_str())||input.output_index!=current.previous_output.vout {
  return Err(ERROR.into());
 }
 let text=input.unfinished_script_sig.as_deref().ok_or(ERROR)?;
 // Bound allocation before decoding caller-controlled witness material.
 if text.len()>(44+MAX_PREIMAGE_BYTES+4)*2{return Err(ERROR.into());}
 let template=hex::decode(text).map_err(|_|ERROR)?;
 if template.len()<45||&template[..11]!=b"\x09signature\x21"||&template[11..44]!=public_key{return Err(ERROR.into());}
 let suffix=&template[44..];let owner=tbc_sdk::hash::hash160(public_key);
 if suffix==[0] {
  return code.verify_refund(&owner,current.sequence,tx.lock_time).map_err(|_|ERROR.into());
 }
 if suffix.last()!=Some(&0x51){return Err(ERROR.into());}
 let push=&suffix[..suffix.len()-1];
 // A single minimal data push, followed by OP_TRUE. Reject trailing opcodes,
 // alternate stack programs and noncanonical encodings rather than interpreting
 // arbitrary script in the signer. Borrow secret bytes without another copy.
 let numeric=[push.first().copied().unwrap_or(0).wrapping_sub(0x50)];
 let secret:&[u8]=match push {
  [0]=>&[],[0x4f]=>&[0x81],[0x51..=0x60]=>&numeric,
  [op @ 1..=75,data @ ..] if data.len()==usize::from(*op)
   &&!(data.len()==1&&(data[0]==0x81||(1..=16).contains(&data[0])))=>data,
  [0x4c,len,data @ ..] if *len>=76&&data.len()==usize::from(*len)=>data,
  [0x4d,lo,hi,data @ ..] if data.len()>=256&&data.len()==usize::from(u16::from_le_bytes([*lo,*hi]))=>data,
  _=>return Err(ERROR.into()),
 };
 if secret.len()>MAX_PREIMAGE_BYTES{return Err(ERROR.into());}
 code.verify_claim(&owner,secret).map_err(|_|ERROR.into())
}
fn apply_associated_input(
    transaction: &mut Transaction,
    input_index: usize,
    input: &AssociatedInput,
    public_key: &[u8],
    signature: &[u8],
) -> Result<(), String> {
    let script_text = input.script.as_ref().ok_or_else(|| format!("input {input_index} script is required"))?;
    input.satoshis.ok_or_else(|| format!("input {input_index} satoshis is required"))?;
    parse_script(script_text, &format!("input {input_index} script"))?;
    match input.script_sig_type {
        AssociatedScriptType::P2pkh => {
            let mut bytes=Vec::new();push_data(&mut bytes,signature)?;push_data(&mut bytes,public_key)?;
            transaction.inputs[input_index].script_sig=Script::from_bytes(bytes);Ok(())
        },
        AssociatedScriptType::Tbc20 | AssociatedScriptType::Tbc20Contract => {
            let is_contract = matches!(input.script_sig_type, AssociatedScriptType::Tbc20Contract);
            let pre_tx = Transaction::from_hex(input.pre_tx.as_ref().ok_or_else(|| format!("input {input_index} preTx is required"))?)
                .map_err(|error| format!("input {input_index} preTx: {error}"))?;
            let pre_pre = hex::decode(input.pre_pre_tx_data.as_ref().ok_or_else(|| format!("input {input_index} prePreTxData is required"))?)
                .map_err(|error| format!("input {input_index} prePreTxData: {error}"))?;
            let mut unlocking = current_tx_data(transaction, input_index).map_err(|error| error.to_string())?;
            unlocking.extend_from_slice(&pre_pre);
            push_data(&mut unlocking, signature)?;
            push_data(&mut unlocking, public_key)?;
            if is_contract {
                let version = input.ft_version.filter(|version| (1..=3).contains(version))
                    .ok_or_else(|| format!("input {input_index} ftVersion must be 1, 2, or 3"))?;
                let contract = Transaction::from_hex(input.contract_tx.as_ref().ok_or_else(|| format!("input {input_index} contractTx is required"))?)
                    .map_err(|error| format!("input {input_index} contractTx: {error}"))?;
                unlocking.extend_from_slice(&current_inputs_data(transaction).map_err(|error| error.to_string())?);
                let vout = if version > 1 { -1 } else {
                    transaction.inputs.first().map(|item| item.previous_output.vout as i32).unwrap_or_default()
                };
                unlocking.extend_from_slice(&contract_tx_data(&contract, vout).map_err(|error| error.to_string())?);
                if version > 2 { unlocking.push(0); }
            }
            unlocking.extend_from_slice(&pre_tx_data(&pre_tx, input.output_index as usize).map_err(|error| error.to_string())?);
            transaction.inputs[input_index].script_sig = Script::from_bytes(unlocking);
            Ok(())
        }
        AssociatedScriptType::Other => {
            const PLACEHOLDER: &[u8] = b"\x09signature";
            let mut template = hex::decode(input.unfinished_script_sig.as_ref().ok_or_else(|| format!("input {input_index} unfinishedScriptSig is required"))?)
                .map_err(|error| format!("input {input_index} unfinishedScriptSig: {error}"))?;
            let positions = signature_placeholder_positions(&template)?;
            if positions.len() != 1 {
                return Err(format!("input {input_index} unfinishedScriptSig must contain exactly one signature placeholder"));
            }
            let mut pushed = Vec::new();
            push_data(&mut pushed, signature)?;
            template.splice(positions[0]..positions[0] + PLACEHOLDER.len(), pushed);
            transaction.inputs[input_index].script_sig = Script::from_bytes(template);
            Ok(())
        }
        AssociatedScriptType::Tbc20Coin | AssociatedScriptType::Tbc20CoinContract =>
            Err("StableCoin associated signing is outside this private native capability".to_owned()),
        AssociatedScriptType::TbcLopMatch => Err("LOP match covenant does not request a signature".to_owned()),
        AssociatedScriptType::CurrentTbc20 | AssociatedScriptType::CurrentCoin =>
            Err("Current covenant requires its prepared proof".to_owned()),
    }
}

// Interpret push boundaries, not substrings: ancestry/proof bytes can contain
// the placeholder byte sequence without being a signature slot. Validate the
// whole script so a truncated trailing push is never returned as signed raw.
fn signature_placeholder_positions(script: &[u8]) -> Result<Vec<usize>, String> {
    let mut positions = Vec::new();
    let mut cursor = 0usize;
    while cursor < script.len() {
        let start = cursor;
        let opcode = script[cursor];
        cursor += 1;
        let length = match opcode {
            0..=75 => opcode as usize,
            76..=78 => {
                let width = 1usize << (opcode - 76);
                let end = cursor.checked_add(width).ok_or("Invalid template push length")?;
                let bytes = script.get(cursor..end).ok_or("Truncated template push length")?;
                let mut length = 0u32;
                for (i, byte) in bytes.iter().enumerate() { length |= (*byte as u32) << (i * 8); }
                cursor = end;
                usize::try_from(length).map_err(|_| "Template push length overflow")?
            }
            _ => continue,
        };
        let end = cursor.checked_add(length).ok_or("Template push length overflow")?;
        let data = script.get(cursor..end).ok_or("Truncated template push data")?;
        if opcode == 9 && data == b"signature" { positions.push(start); }
        cursor = end;
    }
    Ok(positions)
}

fn cache_pre_txs(inputs: &[AssociatedInput], ancestry: &mut HashMap<String, Transaction>) -> Result<(), String> {
    for input in inputs {
        if let Some(raw) = &input.pre_tx {
            let transaction = Transaction::from_hex(raw).map_err(|error| format!("preTx: {error}"))?;
            ancestry.insert(transaction.txid().to_string(), transaction);
        }
        if let Some(raws)=&input.ancestor_transactions{
            if !current_token::is_current(input.script_sig_type)||raws.len()>6{return Err("Invalid current ancestor material scope".into());}
            for raw in raws{
                let transaction=current_token::parse_parent(raw)?;
                ancestry.insert(transaction.txid().to_string(),transaction);
            }
        }
    }
    Ok(())
}

fn local_pre_pre_tx_data(
    pre_tx: &Transaction,
    output_index: usize,
    ancestry: &HashMap<String, Transaction>,
) -> Result<Vec<u8>, String> {
    let tape = pre_tx.outputs.get(output_index + 1)
        .ok_or_else(|| format!("preTx output {output_index} is missing its tape output"))?
        .script_pubkey.as_bytes();
    if tape.len() < 51 { return Err("preTx tape output is shorter than 51 bytes".to_owned()); }
    let mut data = vec![0x57];
    for byte_offset in (0..=40).rev().step_by(8) {
        if tape[3 + byte_offset..3 + byte_offset + 8].iter().all(|byte| *byte == 0) { continue; }
        let input = pre_tx.inputs.get(byte_offset / 8)
            .ok_or_else(|| format!("preTx input {} required by tape is missing", byte_offset / 8))?;
        let ancestor = ancestry.get(&input.previous_output.txid.to_string())
            .ok_or_else(|| format!("missing pre-pre transaction {}", input.previous_output.txid))?;
        data.extend_from_slice(&tbc_sdk::contracts::ft::unlock::pre_pre_tx_data(
            ancestor,
            input.previous_output.vout as usize,
        ).map_err(|error| error.to_string())?);
    }
    Ok(data)
}

fn push_data(output: &mut Vec<u8>, data: &[u8]) -> Result<(), String> {
    match data.len() {
        0..=75 => output.push(data.len() as u8),
        76..=0xff => { output.push(0x4c); output.push(data.len() as u8); }
        _ => return Err("unlock push data exceeds 255 bytes".to_owned()),
    }
    output.extend_from_slice(data);
    Ok(())
}

fn parse_script(value: &str, field: &str) -> Result<Script, String> {
    hex::decode(value).map(Script::from_bytes)
        .or_else(|_| Script::from_asm(value).map_err(|_| format!("Invalid {field}")))
}
