//! Keyless selected-material HTLC for new TBC20/Coin, pinned af776161.
//! Shared proof recipes, external signing and exact witness fee reservation.
//! No keys, HTTP, wallet policy, persistence or implicit funding selection.
use std::collections::BTreeMap;
use crate::{EngineError,ErrorCode,signing::{PlannedInput,PlannedOutput,Tbc20OutputGroup,Tbc20ContractControllerReference}};
use super::{coin,tbc20,tbc20_transfer::{allocate,intern,public_context,FeeInput},
    htlc::{Code,REFUND_SEQUENCE},htlc_transaction::{HtlcPlan,SpendBranch},
    controlled_token::{address_controller,inspect,pair,recipe,selected_input,fee_input,Assembly,Material}};
pub use super::controlled_token::{TokenProfile,TokenInput,ChainContext};
pub struct LockOptions<'a> {
    pub profile: TokenProfile,
    pub inputs: &'a [TokenInput<'a>],
    pub funding: &'a FeeInput<'a>,
    /// Independent asset identity bound by the caller's issuance validation.
    pub expected_identity: &'a [u8],
    pub code: &'a Code,
    pub amount: u128,
    pub chain: ChainContext,
    pub max_fee: u64,
}
pub struct SpendOptions<'a> {
    pub profile: TokenProfile,
    /// Exact deploy pair: HTLC vout 0 (100 atomic), Token Code/Tape vout 1/2.
    pub token: TokenInput<'a>,
    pub funding: &'a FeeInput<'a>,
    pub expected_identity: &'a [u8],
    pub branch: &'a SpendBranch,
    pub chain: ChainContext,
    pub max_fee: u64,
}
fn invalid(message: &str) -> EngineError {
    EngineError { code: ErrorCode::InvalidPlan, message: message.into(), path: None }
}
fn insufficient() -> EngineError {
    EngineError { code: ErrorCode::InsufficientFunds, message: "HTLC Token funding or balance insufficient".into(), path: None }
}
fn hex(bytes: &[u8]) -> String { bytes.iter().map(|b| format!("{b:02x}")).collect() }
fn contract_controller(code: &Code) -> [u8;21] {
    let mut out=[0;21];out[..20].copy_from_slice(&code.token_controller());out[20]=1;out
}
pub fn build_lock_plan(options:LockOptions<'_>)->Result<HtlcPlan,EngineError>{
    if options.inputs.is_empty()||options.inputs.len()>5||options.amount==0{return Err(invalid("HTLC Token lock requires positive amount and one to five inputs"));}
    // A later claim/refund spends the escrow Token Code as one input, hence its
    // complete balance must fit that input's single signed-63-bit Tape slot.
    // Never create an escrow that our compatible spend format cannot unlock.
    if options.amount>u128::from(tbc20::MAX_SLOT_AMOUNT){return Err(invalid("HTLC Token locked amount exceeds one spend allocation slot"));}
    let key=options.funding.public_key;
    let lock=options.code.supported_lock_time().map_err(|_|invalid("HTLC Token safe refund lock required"))?;
    let future=if lock<500_000_000{options.chain.height.is_some_and(|height|u64::from(lock)>height)}else{options.chain.median_time_past.is_some_and(|time|u64::from(lock)>time)};
    if options.code.sender_hash!=key.hash160()||!future{return Err(invalid("HTLC Token sender or future refund lock mismatch"));}
    let materials=options.inputs.iter().map(|i|inspect(i,options.profile,options.expected_identity)).collect::<Result<Vec<_>,_>>()?;
    let first=&materials[0];let owner=address_controller(key);
    for m in &materials{
        if m.controller!=owner||!options.chain.mature(m.lock){return Err(invalid("HTLC Token holder or Coin maturity mismatch"));}
        // Compare metadata independently of input quantities and mature locks.
        // SDK combines input locks by maximum, but preserves the first Tape.
        let envelope=|m:&Material|->Result<Vec<u8>,EngineError>{match options.profile{
            TokenProfile::Tbc20=>tbc20::parse_tape(&m.tape).map(|t|t.extension).map_err(|_|invalid("HTLC Token Tape invalid")),
            TokenProfile::Coin=>coin::replace_tape_amounts(&m.tape,[0;6]).and_then(|t|coin::set_lock_time(&t,0)).map_err(|_|invalid("HTLC Coin Tape invalid")),
        }};
        if envelope(m)?!=envelope(first)?{return Err(invalid("HTLC Token input Tape envelopes differ"));}
    }
    // The locked output preserves the first Tape. Validate its future refund
    // now, not only after funds have already been deposited into the contract.
    coin::required_lock_time(&[lock,first.lock]).map_err(|_|invalid("HTLC refund and preserved Coin lock mix domains"))?;
    let lock=coin::required_lock_time(&materials.iter().map(|m|m.lock).collect::<Vec<_>>()).map_err(|_|invalid("HTLC Token Coin locks mix domains"))?;
    let mut remaining:Vec<_>=materials.iter().map(|m|m.balance).collect();let total: u128=remaining.iter().sum();
    if options.amount>total{return Err(insufficient());}
    let mut allocated=vec![];allocate(&mut remaining,contract_controller(options.code),options.amount,&mut allocated)?;
    if allocated.len()!=1{return Err(invalid("HTLC Token locked amount exceeds one contract Code group"));}
    let change: u128=remaining.iter().sum();allocate(&mut remaining,owner,change,&mut allocated)?;
    if allocated.len()>2{return Err(invalid("HTLC Token change exceeds one Code group"));}
    let mut a=Assembly{profile:options.profile,role:"tbc-htlc-lock",inputs:vec![],
        outputs:vec![PlannedOutput{satoshis:100,locking_script:hex(&options.code.encode())}],
        groups:vec![Tbc20OutputGroup{code_vout:0,tape_vout:None}],recipes:vec![],evidence:vec![],lock};
    for out in allocated{pair(options.profile,first,out.controller,out.amounts_by_input,&mut a.outputs,&mut a.groups)?;}
    let mut ids=BTreeMap::new();
    for(input,m)in options.inputs.iter().zip(&materials){
        let r=recipe(input,m,&mut a.evidence,&mut ids,None)?;a.recipes.push((a.inputs.len(),r));a.inputs.push(selected_input(input,m,key,options.profile));
    }
    a.inputs.push(fee_input(options.funding)?);a.finish(key,options.max_fee).map(|p|HtlcPlan{unsigned_plan:p.unsigned_plan,fee:p.fee,maximum_signed_bytes:p.maximum_signed_bytes})
}
pub fn build_spend_plan(options:SpendOptions<'_>)->Result<HtlcPlan,EngineError>{
    let key=options.funding.public_key;let token=&options.token;
    if token.vout!=1{return Err(invalid("HTLC Token spend must select deployed Code at output one"));}
    let m=inspect(token,options.profile,options.expected_identity)?;
    let escrow=&token.parent.outputs[0];
    let code=Code::decode(escrow.script_pubkey.as_bytes()).map_err(|_|invalid("HTLC Token controller Code invalid"))?;
    if escrow.satoshis!=100||m.controller!=contract_controller(&code){return Err(invalid("HTLC Token controller binding mismatch"));}
    let refund=matches!(options.branch,SpendBranch::Refund);
    let htlc_lock=if refund{code.supported_lock_time().map_err(|_|invalid("HTLC refund lock unsupported"))?}else{0};
    let lock=coin::required_lock_time(&[htlc_lock,m.lock]).map_err(|_|invalid("HTLC and Coin locks mix domains"))?;
    let sequence=if refund{REFUND_SEQUENCE}else{u32::MAX};
    options.branch.verify(&code,&key.hash160(),sequence,lock)?;
    if !options.chain.mature(lock){return Err(invalid("HTLC Token spend is not mature at supplied chain context"));}
    let mut a=Assembly{profile:options.profile,role:if refund{"tbc-htlc-refund"}else{"tbc-htlc-claim"},inputs:vec![PlannedInput{
        previous_transaction_id:token.parent.txid().to_string(),previous_output_index:0,previous_output_script:hex(escrow.script_pubkey.as_bytes()),
        previous_output_satoshis:100,sequence,signer:public_context(key),unlocking_script:options.branch.descriptor()?,
    }],outputs:vec![],groups:vec![],recipes:vec![],evidence:vec![],lock};
    let amount=u64::try_from(m.balance).ok().filter(|n|*n<=tbc20::MAX_SLOT_AMOUNT).ok_or_else(||invalid("HTLC Token selected balance exceeds one spend allocation slot"))?;
    let mut slots=[0;6];slots[1]=amount;pair(options.profile,&m,address_controller(key),slots,&mut a.outputs,&mut a.groups)?;
    let mut ids=BTreeMap::new();let source=intern(token.parent,&mut a.evidence,&mut ids);
    a.recipes.push((1,recipe(token,&m,&mut a.evidence,&mut ids,Some(Tbc20ContractControllerReference{source,current_input_index:0}))?));
    a.inputs.push(selected_input(token,&m,key,options.profile));a.inputs.push(fee_input(options.funding)?);
    a.finish(key,options.max_fee).map(|p|HtlcPlan{unsigned_plan:p.unsigned_plan,fee:p.fee,maximum_signed_bytes:p.maximum_signed_bytes})
}
