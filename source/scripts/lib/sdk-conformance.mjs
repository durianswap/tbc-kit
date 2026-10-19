import fs from "node:fs";
import path from "node:path";

import { canonicalize } from "./canonical-json.mjs";
import { readJson } from "./repository.mjs";

const PACKAGE_PATHS = Object.freeze([
  "packages/core/package.json",
  "packages/tbc-engine/package.json",
  "packages/host/package.json",
  "packages/provider/package.json",
  "packages/wallet-standard/package.json",
]);

const PROVIDER_FACADE = Object.freeze([
  "request",
  "on",
  "removeListener",
  "destroy",
]);
const TRANSPORT_LIFECYCLE = Object.freeze([
  "unique-session-id",
  "atomic-delivery",
  "promise-before-events",
  "sent-before-page-dispatch",
  "abort-suppresses-late-delivery",
  "close-rejects-pending",
  "replay-fails-closed",
]);
const PROVIDER_PORTABILITY_TARGETS = Object.freeze([
  "browser",
  "worker",
  "chrome-mv3-csp",
  "react-native-hermes",
  "node-esm",
  "node-cjs",
]);
const PROVIDER_PACKAGE_ARTIFACTS = Object.freeze([
  "esm",
  "commonjs",
  "declarations",
  "declaration-maps",
  "root-export",
  "in-memory-export",
  "webview-export",
]);
const PROVIDER_FORBIDDEN_CAPABILITIES = Object.freeze([
  "trusted-context-input",
  "host-port-access",
  "transaction-engine-access",
  "wallet-private-state",
  "execute-shortcut",
  "sign-and-send-shortcut",
  "ambient-platform-authority",
]);
const DISCOVERY_SCENARIOS = Object.freeze([
  "zero-wallets",
  "one-wallet",
  "multiple-wallets",
  "duplicate-registration",
  "official-unregister",
  "wallet-before-dapp",
  "dapp-before-wallet",
  "malformed-feature",
  "incompatible-major",
  "ssr-import",
]);
const DISCOVERY_PORTABILITY_TARGETS = Object.freeze([
  "browser",
  "ssr-esm",
  "ssr-commonjs",
]);
const DISCOVERY_FORBIDDEN_BEHAVIORS = Object.freeze([
  "private-registry",
  "automatic-selection",
  "wallet-priority",
  "persistent-wallet-id",
  "window-turing-injection",
  "eip6963-tbc-registration",
  "provider-call-during-discovery",
]);
const EXAMPLE_PUBLIC_DEPENDENCIES = Object.freeze([
  "@tbc-wallet/core",
  "@tbc-wallet/host",
  "@tbc-wallet/provider",
  "@tbc-wallet/tbc-engine",
  "@tbc-wallet/wallet-standard",
]);
const EXAMPLE_SCENARIOS = Object.freeze([
  "account-authorization",
  "arbitrary-mainnet-transfer",
  "testnet-transfer",
  "multi-input-selection",
  "exact-spend",
  "change-output",
  "concurrent-same-method",
  "sign-only-no-broadcast",
  "provider-close",
  "request-abort",
  "cross-session-request-id-isolation",
  "pending-close-host-cancellation",
  "pre-registration-provider-close",
  "pre-registration-controller-close",
  "abort-host-cancellation",
  "durable-delivery-replay",
]);
const EXAMPLE_FORBIDDEN_DEPENDENCIES = Object.freeze([
  "turing-wallet-plugin",
  "wallet-vault/1",
  "keyring",
  "private-wallet-source",
]);

function assert(condition, message) {
  if (!condition) throw new Error(`SDK conformance failed: ${message}`);
}

function assertExact(actual, expected, label) {
  assert(canonicalize(actual) === canonicalize(expected), `${label} drifted`);
}

function sortedKeys(value) {
  return Object.keys(value).sort();
}

export function runSdkConformance(root) {
  const providerProfile = readJson(root, "conformance/provider-profile.json");
  const discoveryProfile = readJson(
    root,
    "conformance/wallet-standard-profile.json",
  );
  const exampleProfile = readJson(
    root,
    "conformance/third-party-wallet-profile.json",
  );
  const methodRegistry = readJson(root, "registry/methods.json");
  const eventRegistry = readJson(root, "registry/events.json");
  const portRegistry = readJson(root, "registry/integration-ports.json");
  const packages = PACKAGE_PATHS.map((relative) => readJson(root, relative));
  const packageByName = new Map(packages.map((manifest) => [manifest.name, manifest]));
  const rootManifest = readJson(root, "package.json");

  assertExact(
    providerProfile.methods,
    methodRegistry.methods.map(({ name }) => name),
    "Provider methods",
  );
  assertExact(
    providerProfile.events,
    eventRegistry.events.map(({ name }) => name),
    "Provider events",
  );
  assertExact(
    providerProfile.atomicDelivery,
    ["deliveryId", "response", "events"],
    "atomic delivery",
  );
  assert(providerProfile.limits.canonicalJsonBytes === 4 * 1024 * 1024, "message limit");
  assert(providerProfile.limits.jsonRpcProfile === "strict-single-request", "JSON-RPC profile");
  assertExact(providerProfile.providerFacade, PROVIDER_FACADE, "Provider facade");
  assertExact(
    providerProfile.transportLifecycle,
    TRANSPORT_LIFECYCLE,
    "Provider transport lifecycle claims",
  );
  assertExact(
    providerProfile.portabilityTargets,
    PROVIDER_PORTABILITY_TARGETS,
    "Provider portability claims",
  );
  assertExact(
    providerProfile.packageArtifacts,
    PROVIDER_PACKAGE_ARTIFACTS,
    "Provider package artifact claims",
  );
  assertExact(
    providerProfile.forbiddenCapabilities,
    PROVIDER_FORBIDDEN_CAPABILITIES,
    "Provider forbidden capabilities",
  );
  assertExact(providerProfile.commands, [
    "npm run test:provider",
    "npm run check:provider-portability",
    "npm pack ./packages/provider --dry-run",
  ], "Provider evidence commands");

  const providerManifest = packageByName.get(providerProfile.package);
  assert(providerManifest?.version === providerProfile.version, "Provider package version");
  assertExact(
    sortedKeys(providerManifest.exports),
    [".", "./in-memory", "./webview"],
    "Provider exports",
  );

  const discoveryManifest = packageByName.get(discoveryProfile.package);
  assert(discoveryManifest?.version === discoveryProfile.version, "discovery package version");
  assert(
    discoveryManifest.dependencies?.[discoveryProfile.registryPackage] ===
      discoveryProfile.registryVersion,
    "official Wallet Standard dependency",
  );
  assert(discoveryProfile.feature === "tbc:provider", "discovery feature");
  assert(discoveryProfile.autoSelect === false, "discovery auto-selection");
  assert(discoveryProfile.persistentWalletIdentity === false, "persistent Wallet ID");
  assert(discoveryProfile.eip6963Role === "evm-only", "EIP-6963 role");
  assertExact(discoveryProfile.scenarios, DISCOVERY_SCENARIOS, "discovery scenarios");
  assertExact(
    discoveryProfile.portabilityTargets,
    DISCOVERY_PORTABILITY_TARGETS,
    "discovery portability claims",
  );
  assertExact(
    discoveryProfile.forbiddenBehaviors,
    DISCOVERY_FORBIDDEN_BEHAVIORS,
    "discovery forbidden behaviors",
  );
  assertExact(discoveryProfile.commands, [
    "npm run test:wallet-standard",
    "npm run check:wallet-standard-portability",
    "npm pack ./packages/wallet-standard --dry-run",
  ], "discovery evidence commands");

  const exampleManifest = readJson(root, `${exampleProfile.example}/package.json`);
  assert(exampleProfile.privateCodeFree === true, "third-party private-code boundary");
  assertExact(
    exampleProfile.publicDependencies,
    EXAMPLE_PUBLIC_DEPENDENCIES,
    "third-party public dependency allowlist",
  );
  assertExact(
    sortedKeys(exampleManifest.dependencies),
    [...exampleProfile.publicDependencies].sort(),
    "third-party public dependencies",
  );
  assertExact(
    exampleProfile.dappBoundary,
    ["@tbc-wallet/provider"],
    "third-party DApp boundary",
  );
  assertExact(
    exampleProfile.hostPorts,
    portRegistry.ports.map(({ name }) => name),
    "third-party Host Ports",
  );
  assertExact(
    exampleProfile.transactionPath,
    [
      "normalize",
      "plan",
      "approval-binding",
      "signer.sign",
      "finalize",
      "broadcast",
    ],
    "third-party transaction path",
  );
  assertExact(exampleProfile.scenarios, EXAMPLE_SCENARIOS, "third-party scenarios");
  assertExact(
    exampleProfile.forbiddenDependencies,
    EXAMPLE_FORBIDDEN_DEPENDENCIES,
    "third-party forbidden dependencies",
  );
  assertExact(exampleProfile.commands, [
    "npm run test:example:minimal",
    "node scripts/check-example-boundary.mjs",
  ], "third-party evidence commands");
  for (const relative of [
    `${exampleProfile.example}/src/dapp.ts`,
    `${exampleProfile.example}/src/wallet.ts`,
    `${exampleProfile.example}/test/e2e.test.mjs`,
    "scripts/check-example-boundary.mjs",
  ]) {
    assert(fs.existsSync(path.join(root, relative)), `${relative} is missing`);
  }

  for (const command of [
    "test:provider",
    "test:wallet-standard",
    "test:example:minimal",
    "check:provider-portability",
    "check:wallet-standard-portability",
  ]) {
    assert(typeof rootManifest.scripts?.[command] === "string", `${command} command`);
    assert(
      rootManifest.scripts.check.includes(`npm run ${command}`),
      `${command} aggregate evidence`,
    );
  }

  return Object.freeze({
    version: providerProfile.version,
    packages: packages.length,
    provider: Object.freeze({
      methods: providerProfile.methods.length,
      events: providerProfile.events.length,
      facade: Object.freeze([...providerProfile.providerFacade]),
      atomicDelivery: true,
      canonicalJsonBytes: providerProfile.limits.canonicalJsonBytes,
    }),
    transport: Object.freeze({
      lifecycle: Object.freeze([...providerProfile.transportLifecycle]),
    }),
    discovery: Object.freeze({
      officialRegistry: true,
      registryPackage: discoveryProfile.registryPackage,
      registryVersion: discoveryProfile.registryVersion,
      feature: discoveryProfile.feature,
      autoSelect: discoveryProfile.autoSelect,
    }),
    portability: Object.freeze({
      targets: Object.freeze([...providerProfile.portabilityTargets]),
      packageArtifacts: Object.freeze([...providerProfile.packageArtifacts]),
    }),
    thirdPartyExample: Object.freeze({
      privateCodeFree: exampleProfile.privateCodeFree,
      hostPorts: exampleProfile.hostPorts.length,
      scenarios: exampleProfile.scenarios.length,
      transactionPath: Object.freeze([...exampleProfile.transactionPath]),
    }),
  });
}
