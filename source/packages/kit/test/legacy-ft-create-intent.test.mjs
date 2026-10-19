import assert from "node:assert/strict";
import test from "node:test";

import {
  LegacyFtCreateParameterError,
  createLegacyFtCreateIntentResolver,
} from "../dist/esm/wallet.js";

const CHAIN_ID = "tbc:testnet";
const MAINNET_CHAIN_ID = "tbc:mainnet";
const SOURCE = "1BgGZ9tcN4rm9KBzDn7KprQz87SZ26SAMH";

test("Legacy FT create mapping is canonical, deterministic, and exact", async () => {
  const resolver = createLegacyFtCreateIntentResolver({ chainId: CHAIN_ID });
  const request = [{
    flag: "FT_MINT",
    ft_data: JSON.stringify({
      name: "Shared Token",
      symbol: "SHR",
      amount: 12.345678,
      decimal: 6,
    }),
  }];
  const first = await resolver.resolve(request, SOURCE);
  const second = await resolver.resolve(structuredClone(request), SOURCE);
  assert.deepEqual(first, second);
  assert.match(first.clientRequestId, /^legacy-ft-create:[0-9a-f]{64}$/u);
  assert.deepEqual(first.intent, {
    version: "1.0",
    type: "tbc.ft.create",
    name: "Shared Token",
    symbol: "SHR",
    decimals: 6,
    initialSupply: "12345678",
  });
});

test("Legacy FT create binds the same address format to the selected Mainnet chain profile", async () => {
  const resolver = createLegacyFtCreateIntentResolver({ chainId: MAINNET_CHAIN_ID });
  const result = await resolver.resolve([{
    flag: "FT_MINT",
    ft_data: JSON.stringify({ name: "Mainnet Vector", symbol: "MV", amount: 1, decimal: 6 }),
  }], SOURCE);
  assert.equal(result.chainId, MAINNET_CHAIN_ID);
  assert.equal(result.from, SOURCE);
  assert.equal(result.intent.initialSupply, "1000000");
});

test("Legacy FT create mapping rejects hidden fields, precision loss, and invalid metadata", async () => {
  const resolver = createLegacyFtCreateIntentResolver({ chainId: CHAIN_ID });
  const valid = {
    flag: "FT_MINT",
    ft_data: JSON.stringify({ name: "Shared", symbol: "SHR", amount: 1, decimal: 6 }),
  };
  for (const request of [
    [{ ...valid, hidden: true }],
    [{ ...valid, ft_data: JSON.stringify({ name: "Shared", symbol: "SHR", amount: 0, decimal: 6 }) }],
    [{ ...valid, ft_data: JSON.stringify({ name: "Shared", symbol: "SHR", amount: 1.0000001, decimal: 6 }) }],
    [{ ...valid, ft_data: JSON.stringify({ name: "Shared", symbol: "SHR", amount: 1, decimal: 8 }) }],
  ]) {
    await assert.rejects(
      resolver.resolve(request, SOURCE),
      LegacyFtCreateParameterError,
    );
  }
});
