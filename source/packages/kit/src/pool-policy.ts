const SERVICE_FEE_RATE_BY_PLAN = Object.freeze({
  1: 35,
  2: 35,
  3: 135,
  4: 335,
  5: 535,
  6: 330,
} as const);

export function poolServiceFeeRate(lpPlan: number): number | undefined {
  return SERVICE_FEE_RATE_BY_PLAN[
    lpPlan as keyof typeof SERVICE_FEE_RATE_BY_PLAN
  ];
}
