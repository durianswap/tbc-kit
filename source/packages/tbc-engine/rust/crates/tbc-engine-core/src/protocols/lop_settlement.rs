//! Read-free LOP settlement arithmetic, pinned SDK integer/floor semantics.
//! Not a node/UTXO check or spend authorization. Match witnesses and business
//! planning must bind these numbers to authenticated Code, Tape and recipients.
use super::lop::{Code,Market,Side,LopError,Result,PRICE_SCALE};
use serde::Serialize;
const MAX:u64=i64::MAX as u64;
const MAX_NATIVE:u64=9_007_199_254_740_991;
fn amount(value:u64)->Result<u64>{if value>MAX{Err(LopError("LOP amount exceeds signed allocation range"))}else{Ok(value)}}
fn floor_product(a:u64,b:u64)->Result<u64>{
    let n=u128::from(a)*u128::from(b)/u128::from(PRICE_SCALE);
    if n>u128::from(MAX){Err(LopError("LOP scaled amount exceeds signed allocation range"))}else{Ok(n as u64)}
}
/// Match fee change must not alias either order owner's payout. This is a
/// covenant restriction, not a new custody/trusted matcher requirement.
/// Tax destinations come from the two exact order Codes, not caller metadata.
pub fn validate_match_receivers(buy:&Code,sell:&Code,fee_change:[u8;20],a_tax:[u8;20],b_tax:[u8;20])->Result<()>{
    if fee_change==buy.terms.owner_hash||fee_change==sell.terms.owner_hash{return Err(LopError("LOP matcher change must differ from both order owners"));}
    let skip_native_zero=matches!(buy.market,Market::NativeToken{..})&&buy.terms.fee_rate==0;
    if (!skip_native_zero&&a_tax!=buy.tax_hash)||b_tax!=sell.tax_hash{return Err(LopError("LOP tax destination differs from committed order"));}
    Ok(())
}
#[derive(Debug,Clone,Copy,PartialEq,Eq,Serialize)]
#[serde(rename_all="camelCase")]
pub struct Settlement{
    pub matched_a:u64,pub a_to_buyer:u64,pub a_tax:u64,
    pub paid_b:u64,pub b_to_seller:u64,pub b_tax:u64,
    pub sell_remaining:u64,pub buy_remaining:u64,
    /// Actual escrow change, not a second multiplication of the remaining
    /// nominal volume. Flooring is not distributive across partial matches.
    pub a_escrow_change:u64,pub b_escrow_change:u64,
    pub native_zero_tax_placeholder:bool,
}
impl Settlement{
    /// The current SDK layout can carry at most one continued order. Refuse to
    /// drop residual units on an exhausted order or redirect them to matcher fees.
    /// Keep the arithmetic quote inspectable even when this layout cannot settle.
    pub fn require_conserving_layout(&self)->Result<()>{
        if (self.sell_remaining==0&&self.a_escrow_change!=0)||(self.buy_remaining==0&&self.b_escrow_change!=0){
            return Err(LopError("LOP exhausted order retains unallocated escrow; match layout cannot discard it"));
        }
        if (self.sell_remaining>0&&self.a_escrow_change==0)||(self.buy_remaining>0&&self.b_escrow_change==0){
            return Err(LopError("LOP remaining order has no escrow"));
        }Ok(())
    }
    /// Keep every original field unchanged except remaining nominal volume.
    pub fn continuation(&self,buy:&Code,sell:&Code)->Result<Option<Code>>{
        self.require_conserving_layout()?;
        // The native-market buy covenant requires the continued quote escrow
        // to equal floor(remaining native volume * the original buy price).
        // Repeated flooring can leave an extra unit. Do not construct an
        // invalid continuation or erase the unit to make its equality pass.
        // Token/Token has a different covenant; do not impose this rule there.
        if matches!(buy.market,Market::NativeToken{..})&&self.buy_remaining>0
            &&self.b_escrow_change!=floor_product(self.buy_remaining,buy.terms.unit_price)?{
            return Err(LopError("LOP native buy continuation escrow differs from covenant amount; cancel or choose a compatible fill"));
        }
        if self.sell_remaining>0{Ok(Some(sell.with_sale_volume(self.sell_remaining)))}
        else if self.buy_remaining>0{Ok(Some(buy.with_sale_volume(self.buy_remaining)))}
        else{Ok(None)}
    }
}
/// A is native TBC for NativeToken, otherwise token A. B is the quote token.
/// Escrow amounts must come from authenticated previous outputs, never page claims.
pub fn quote_match(buy:&Code,sell:&Code,escrow_a:u64,escrow_b:u64)->Result<Settlement>{
    buy.terms.validate_new_order()?;sell.terms.validate_new_order()?;
    // Both pinned market covenants require distinct buyer/seller payout owners.
    // Fixed-SDK self-matches fail EQUALVERIFY on both order inputs. Reject before
    // creating Token/fee signing tasks, rather than emitting a doomed bundle.
    if buy.terms.owner_hash==sell.terms.owner_hash{return Err(LopError("LOP order owners must differ under pinned covenants"));}
    // Both pinned order scripts bind the peer's fee recipient as well as
    // their own payout. Distinct recipients cannot be repaired by swapping
    // output destinations, even for zero-fee orders. Check before signing.
    if buy.tax_hash!=sell.tax_hash{return Err(LopError("LOP committed fee recipients must match under pinned covenants"));}
    if buy.side!=Side::Buy||sell.side!=Side::Sell||buy.market!=sell.market||
        buy.terms.asset_a!=sell.terms.asset_a||buy.terms.asset_b!=sell.terms.asset_b{
        return Err(LopError("LOP opposite order roles, market or asset identities differ"));
    }
    let native=matches!(buy.market,Market::NativeToken{..});
    if !native&&buy.terms.unit_price!=sell.terms.unit_price{return Err(LopError("LOP Token pair unit prices differ"));}
    if native&&(escrow_a!=sell.terms.sale_volume||escrow_a>MAX_NATIVE){return Err(LopError("LOP native sale escrow differs from order or safe atomic range"));}
    amount(escrow_a)?;amount(escrow_b)?;
    let matched_a=buy.terms.sale_volume.min(sell.terms.sale_volume);
    let paid_b=floor_product(matched_a,sell.terms.unit_price)?;
    let a_tax=floor_product(matched_a,buy.terms.fee_rate)?;
    let b_tax=floor_product(paid_b,sell.terms.fee_rate)?;
    let a_to_buyer=matched_a.checked_sub(a_tax).filter(|v|*v>0).ok_or(LopError("LOP A payout is not positive after fee"))?;
    let b_to_seller=paid_b.checked_sub(b_tax).filter(|v|*v>0).ok_or(LopError("LOP B payout is not positive after fee"))?;
    let placeholder=native&&buy.terms.fee_rate==0&&a_tax==0;
    if native&&!placeholder&&a_tax<10{return Err(LopError("LOP native tax below covenant dust limit"));}
    Ok(Settlement{matched_a,a_to_buyer,a_tax,paid_b,b_to_seller,b_tax,
        sell_remaining:sell.terms.sale_volume-matched_a,buy_remaining:buy.terms.sale_volume-matched_a,
        a_escrow_change:escrow_a.checked_sub(matched_a).ok_or(LopError("LOP sell escrow insufficient"))?,
        b_escrow_change:escrow_b.checked_sub(paid_b).ok_or(LopError("LOP buy escrow insufficient"))?,
        native_zero_tax_placeholder:placeholder})
}
