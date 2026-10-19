import { normalizeAmmFeePolicy, describeAmmFeePolicy } from '@tbc/kit';

// This function performs no wallet, network, signing or broadcast action.
export function customAmmFees(serviceAddress: string) {
  const feePolicy = normalizeAmmFeePolicy({
    lpFeeRate: 20,
    taxFeeRate: 0,
    serviceProviderFeeRate: 10,
    protocolFeeRate: 0,
    feeAddress: serviceAddress,
  });
  return { feePolicy, display: describeAmmFeePolicy(feePolicy) };
}
