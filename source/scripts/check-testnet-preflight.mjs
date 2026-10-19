import { pathToFileURL } from "node:url";

import {
  runTbcTestnetReadOnlyPreflight,
} from "../examples/third-party-wallet-minimal/dist/esm/testnet-adapter.js";

export async function runTbcTestnetPreflightCommand({
  fetch: fetcher = globalThis.fetch,
  write = (chunk) => process.stdout.write(chunk),
} = {}) {
  const result = await runTbcTestnetReadOnlyPreflight({ fetch: fetcher });
  write(`${JSON.stringify(result)}\n`);
  return result;
}

const entryUrl = process.argv[1] === undefined
  ? undefined
  : pathToFileURL(process.argv[1]).href;

if (entryUrl === import.meta.url) {
  try {
    await runTbcTestnetPreflightCommand();
  } catch (error) {
    process.stderr.write(`${JSON.stringify({
      status: "fail",
      code: typeof error?.code === "string" ? error.code : "TESTNET_PREFLIGHT_FAILED",
    })}\n`);
    process.exitCode = 1;
  }
}
