import { runCryptoConformance } from "./lib/crypto-conformance.mjs";
import { runCancellationConformance } from "./lib/cancellation-conformance.mjs";
import { runClosureConformance } from "./lib/closure-conformance.mjs";
import { runDocumentConformance } from "./lib/document-conformance.mjs";
import { runLifecycleConformance } from "./lib/lifecycle-conformance.mjs";
import { runProviderSessionConformance } from "./lib/provider-session-conformance.mjs";
import { repositoryRoot } from "./lib/repository.mjs";
import { runReplayConformance } from "./lib/replay-conformance.mjs";
import { runSchemaConformance } from "./lib/schema-conformance.mjs";
import { runSemanticConformance } from "./lib/semantic-conformance.mjs";
import { runSdkConformance } from "./lib/sdk-conformance.mjs";
import { pathToFileURL } from "node:url";

export function runConformance(root) {
  return {
    status: "pass",
    version: "1.0.0-candidate.2",
    profiles: [
      "schema",
      "semantic",
      "crypto",
      "lifecycle",
      "replay",
      "closure",
      "documents",
      "sdk",
    ],
    schema: runSchemaConformance(root),
    semantic: runSemanticConformance(root),
    crypto: runCryptoConformance(root),
    lifecycle: runLifecycleConformance(root),
    replay: runReplayConformance(root),
    closure: runClosureConformance(root),
    providerSession: runProviderSessionConformance(root),
    cancellation: runCancellationConformance(root),
    documents: runDocumentConformance(root),
    sdk: runSdkConformance(root),
  };
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  const root = repositoryRoot(import.meta.url);
  process.stdout.write(`${JSON.stringify(runConformance(root))}\n`);
}
