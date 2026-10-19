import { assertValidTws, base64Decode, hashCanonical, sha256Hex } from "@tbc-wallet/core";
import { tbcNetworkProfileForChainId } from "./network-context.js";
import { assertTbcAddress } from "./testnet-validation.js";

function record(value: unknown): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value) || Object.getPrototypeOf(value) !== Object.prototype) throw new Error("Invalid Legacy NFT object");
  return value as Record<string, unknown>;
}
function only(value: Record<string, unknown>, keys: readonly string[]) {
  if (Object.keys(value).some(key => !keys.includes(key))) throw new Error("Unsupported Legacy NFT field");
}
function json(value: unknown): Record<string, unknown> {
  if (typeof value !== "string" || value.length > 2_800_000) throw new Error("Invalid Legacy NFT metadata");
  return record(JSON.parse(value));
}
function media(value: unknown): unknown {
  if (typeof value !== "string") throw new Error("Legacy NFT file must be a URI, data URI or serialized media");
  if (/^(https|ipfs|ar):\/\//u.test(value)) return {kind:"uri",uri:value};
  const data = /^data:([^;,]+);base64,([A-Za-z0-9+/]*={0,2})$/u.exec(value);
  if (data) return {kind:"base64",mediaType:data[1],data:data[2],sha256:sha256Hex(base64Decode(data[2]!))};
  // Explicit typed media is accepted; untyped byte strings are ambiguous and rejected.
  return json(value);
}

export interface LegacyNftIntentResolver {
  readonly resolve: (
    request: unknown,
    addressFrom: string,
  ) => Promise<Readonly<Record<string, unknown>>>;
}

/** Historical provider DTO -> the same canonical intents as public walletBuild. */
export function createLegacyNftIntentResolver(
  options: Readonly<{chainId:string}>,
): LegacyNftIntentResolver {
  const profile = tbcNetworkProfileForChainId(options.chainId);
  return Object.freeze({
    async resolve(request: unknown, addressFrom: string) {
      const params = record(Array.isArray(request) && request.length === 1 ? request[0] : request);
      const from = assertTbcAddress(addressFrom,profile.p2pkhVersion).address;
      if (params.broadcastEnabled !== undefined && typeof params.broadcastEnabled !== "boolean") throw new Error("Invalid NFT broadcast option");
      if (params.domain !== undefined && typeof params.domain !== "string") throw new Error("Invalid NFT display domain");
      let intent: Record<string,unknown>;
      if (params.flag === "COLLECTION_CREATE") {
        only(params,["flag","collection_data","broadcastEnabled","domain"]);
        const data=json(params.collection_data);
        only(data,["collectionName","description","supply","file"]);
        if (typeof data.supply !== "number" || !Number.isSafeInteger(data.supply)) throw new Error("Invalid Legacy collection supply");
        intent={type:"tbc.collection.create",version:"1.0",name:data.collectionName,description:data.description,supply:String(data.supply),media:media(data.file)};
      } else if(params.flag === "NFT_CREATE") {
        only(params,["flag","collection_id","nft_data","broadcastEnabled","domain"]);
        const data=json(params.nft_data);
        only(data,["nftName","symbol","description","attributes","file"]);
        if(typeof data.attributes!=="string")throw new Error("Invalid Legacy NFT attributes");
        intent={type:"tbc.nft.mint",version:"1.0",collectionId:params.collection_id,name:data.nftName,symbol:data.symbol,description:data.description,attributes:JSON.parse(data.attributes),...(data.file===undefined?{}:{media:media(data.file)})};
      } else if(params.flag === "NFT_TRANSFER") {
        only(params,["flag","nft_contract_address","address","broadcastEnabled","domain"]);
        intent={type:"tbc.nft.transfer",version:"1.0",contractId:params.nft_contract_address,to:params.address};
        assertTbcAddress(String(params.address),profile.p2pkhVersion);
      } else throw new Error("Unsupported Legacy NFT operation");
      const base={version:"1.0",chainId:options.chainId,from,intent};
      assertValidTws("transactionRequest",base);
      return Object.freeze({...base,clientRequestId:`legacy-nft:${hashCanonical(base)}`});
    },
  });
}
