use crate::families::ft::plan_ft;
use crate::model::{CanonicalRequest, PlannedTransfer, WalletMaterial};
use crate::signing::PublicSigningContext;
use crate::EngineError;

pub(crate) fn plan_stablecoin_transfer(
    request: &CanonicalRequest,
    material: &WalletMaterial<'_>,
    signing: &PublicSigningContext,
) -> Result<PlannedTransfer, EngineError> {
    plan_ft(request, material, signing)
}
