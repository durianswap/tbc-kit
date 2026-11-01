/** Pure quote over supplied, locally validated Pool transaction bytes. This
 * does not fetch, prove unspentness/ancestry, authorize or prepare a trade. */
export type TbcAmmQuoteAction = Readonly<{
    kind: "addTbc";
    amount: string;
    initialFtAmount?: string;
}> | Readonly<{
    kind: "addFt" | "buy" | "sell" | "remove";
    amount: string;
}>;
export type TbcAmmQuoteInput = Readonly<{
    pool: Readonly<{
        txid: string;
        rawTransaction: string;
    }>;
    action: TbcAmmQuoteAction;
}>;
export type TbcAmmQuoteOptions = Readonly<{
    /** Reuse the application's existing Native or WASM keyless engine. */
    engine: Readonly<{
        execute(operation: string, requestJson: string): Promise<string>;
    }>;
}>;
export type TbcAmmQuoteState = Readonly<{
    ftLpAmount: string;
    ftAAmount: string;
    tbcAmount: string;
    poolValue: string;
}>;
export type TbcAmmQuoteFees = Readonly<{
    baseTbcSat: string;
    totalFeeSat: string;
    lpFeeSat: string;
    serviceFeeAccruedSat: string;
    serviceFeePaidSat: string;
    serviceFeeRetainedSat: string;
    poolFeeRetainedSat: string;
    netAmountSat: string;
}>;
type QuoteIdentity = Readonly<{
    standardId: "tbc-amm";
    basis: "local-pool-transaction";
    poolOutpoint: Readonly<{
        txid: string;
        vout: 0;
    }>;
    templateRevision: string;
    poolCodeHash: string;
    ftContractId: string;
    feePolicy: Readonly<{
        totalFeeBps: number;
        lpFeeBps: number;
        serviceFeeAddress: string;
    }>;
}>;
export type TbcAmmQuote = QuoteIdentity & (Readonly<{
    kind: "addTbc" | "addFt";
    quote: Readonly<{
        nextState: TbcAmmQuoteState;
        isFirstAddLP: boolean;
        tbcIncrementSat: string;
        tbcReserveIncrementSat: string;
        ftAIncrementRaw: string;
        ftLpIncrementRaw: string;
    }>;
}> | Readonly<{
    kind: "buy";
    quote: Readonly<{
        nextState: TbcAmmQuoteState;
        inputTbcSat: string;
        effectiveTbcIncrementSat: string;
        poolValueIncrementSat: string;
        ftOutRaw: string;
        fees: TbcAmmQuoteFees;
    }>;
}> | Readonly<{
    kind: "sell";
    quote: Readonly<{
        nextState: TbcAmmQuoteState;
        inputFtRaw: string;
        grossTbcOutSat: string;
        tbcOutSat: string;
        poolValueDecrementSat: string;
        fees: TbcAmmQuoteFees;
    }>;
}> | Readonly<{
    kind: "remove";
    quote: Readonly<{
        nextState: TbcAmmQuoteState;
        ftLpBurnRaw: string;
        ftADecrementRaw: string;
        tbcDecrementSat: string;
        poolValueDecrementSat: string;
    }>;
}>);
/** All amounts use atomic-unit decimal strings, not display units or JS numbers.
 * Fees come from the supplied Pool Code/Tape; callers cannot override them.
 * A quote is not an execution promise. The normal planner must still verify
 * fresh state, input ownership, ancestry, authorization and minimum outputs. */
export declare function quoteTbcAmm(input: TbcAmmQuoteInput, options: TbcAmmQuoteOptions): Promise<TbcAmmQuote>;
export {};
