import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import test from "node:test";

import { ComparisonError } from "./comparison-error.mjs";
import { parseRawTransaction } from "./raw-comparator.mjs";
import { independentlyFinalizedTxid } from "./spent-script-bindings.mjs";
import { compareRawTopologies, deriveRawTopology } from "./raw-topology.mjs";

const txidGoldens = JSON.parse(readFileSync(
  new URL("./raw-topology-goldens.json", import.meta.url),
)).entries;

const u32 = (value) => {
  const bytes = Buffer.alloc(4);
  bytes.writeUInt32LE(value);
  return bytes;
};
const u64 = (value) => {
  const bytes = Buffer.alloc(8);
  bytes.writeBigUInt64LE(BigInt(value));
  return bytes;
};
const compact = (value) => {
  assert.ok(value < 0xfd, "topology fixture uses one-byte CompactSize values");
  return Buffer.from([value]);
};
const serialize = ({ version = 10, inputs, outputs, lockTime = 0 }) => Buffer.concat([
  u32(version),
  compact(inputs.length),
  ...inputs.flatMap((input) => {
    const script = Buffer.from(input.script ?? "", "hex");
    return [
      Buffer.from(input.txid, "hex").reverse(),
      u32(input.vout),
      compact(script.length),
      script,
      u32(input.sequence ?? 0xffff_ffff),
    ];
  }),
  compact(outputs.length),
  ...outputs.flatMap((output) => {
    const script = Buffer.from(output.script, "hex");
    return [u64(output.satoshis), compact(script.length), script];
  }),
  u32(lockTime),
]).toString("hex");

const output = (satoshis, script) => ({ satoshis: String(satoshis), script });
const external = (seed, marker) => serialize({
  inputs: [{ txid: seed.toString(16).padStart(2, "0").repeat(32), vout: 0, script: marker }],
  outputs: [output(10_000, "51"), output(9_000, "52")],
});
const spend = (parents, marker, outputs = [output(8_000, "53"), output(7_000, "54")]) => serialize({
  inputs: parents.map(({ raw, vout }, index) => ({
    txid: independentlyFinalizedTxid(raw),
    vout,
    script: `${marker}${index.toString(16).padStart(2, "0")}`,
  })),
  outputs,
});

function producerFixture(producer, marker) {
  const external0 = external(0x10, `${marker}10`);
  const external1 = external(0x20, `${marker}20`);
  const maintenance0 = spend([{ raw: external0, vout: 0 }], `${marker}30`);
  const maintenance1 = spend([{ raw: external1, vout: 1 }], `${marker}40`);
  const primary = spend([
    { raw: maintenance0, vout: 0 },
    { raw: maintenance1, vout: 1 },
  ], `${marker}50`, [output(6_000, "55")]);
  const transactions = [
    { role: "maintenance", finalizedRaw: maintenance0 },
    { role: "maintenance", finalizedRaw: maintenance1 },
    { role: "primary", finalizedRaw: primary },
  ];
  const fixture = {
    producer,
    scenario: "topology-fixture",
    transactions,
    inputManifest: { externalParents: [external0, external1] },
  };
  if (producer === "production-core") {
    fixture.declaredTransactions = [
      { id: "merge-0", role: "maintenance", dependsOn: [] },
      { id: "merge-1", role: "maintenance", dependsOn: [] },
      { id: "primary", role: "primary", dependsOn: ["merge-0", "merge-1"] },
    ];
  }
  return fixture;
}

const derivePair = () => [
  deriveRawTopology(producerFixture("pinned-source", "01")),
  deriveRawTopology(producerFixture("production-core", "02")),
];

function expectCode(code, callback) {
  assert.throws(callback, (error) => error instanceof ComparisonError && error.code === code);
}

function independentlyDeriveFixtureEdges(fixture) {
  const parsed = fixture.transactions.map(({ finalizedRaw }) => parseRawTransaction(finalizedRaw));
  const txids = fixture.transactions.map(({ finalizedRaw }) => independentlyFinalizedTxid(finalizedRaw));
  assert.equal(new Set(txids).size, txids.length, "fixture transaction txids must be unique");
  const positions = new Map(txids.map((txid, position) => [txid, position]));
  const external = fixture.inputManifest.externalParents.map((raw) => ({
    raw,
    txid: independentlyFinalizedTxid(raw),
    transaction: parseRawTransaction(raw),
  }));
  assert.equal(
    new Set(external.map(({ txid }) => txid)).size,
    external.length,
    "fixture external parent txids must be unique",
  );
  const edges = [];
  for (const [childPosition, transaction] of parsed.entries()) {
    for (const [childInputIndex, input] of transaction.inputs.entries()) {
      const parentPosition = positions.get(input.txid);
      if (parentPosition === undefined) {
        const matches = external.filter(({ txid }) => txid === input.txid);
        assert.equal(matches.length, 1, "external fixture input must resolve uniquely");
        assert.ok(matches[0].transaction.outputs[input.vout], "external fixture vout must resolve");
        continue;
      }
      assert.ok(parentPosition < childPosition, "original fixture edge must point backward");
      assert.ok(parsed[parentPosition].outputs[input.vout], "internal fixture vout must resolve");
      edges.push({
        childPosition,
        childRole: fixture.transactions[childPosition].role,
        childInputIndex,
        parentPosition,
        parentRole: fixture.transactions[parentPosition].role,
        parentVout: input.vout,
      });
    }
  }
  return edges;
}

test("raw topology authenticates canonical txids and compares producer-local edges", () => {
  assert.equal(txidGoldens.length, 2, "one immutable golden is required from each producer");
  assert.deepEqual(txidGoldens.map(({ producer }) => producer), ["pinned-source", "production-core"]);
  for (const golden of txidGoldens) {
    assert.equal(golden.rawTransaction.length / 2, golden.rawByteLength, `${golden.producer} raw byte length drifted`);
    assert.equal(
      createHash("sha256").update(Buffer.from(golden.rawTransaction, "hex")).digest("hex"),
      golden.rawSha256,
      `${golden.producer} raw bytes drifted`,
    );
    const child = serialize({
      inputs: [{ txid: golden.canonicalTxid, vout: 0, script: "51" }],
      outputs: [output(1_000, "51")],
    });
    const topologyInput = {
      producer: golden.producer,
      scenario: `golden-${golden.scenario}`,
      transactions: [{ role: "primary", finalizedRaw: child }],
      inputManifest: {
        externalParents: [{
          rawTransaction: golden.rawTransaction,
          txid: golden.canonicalTxid,
        }],
      },
      ...(golden.producer === "production-core" ? {
        declaredTransactions: [{ id: "primary", role: "primary", dependsOn: [] }],
      } : {}),
    };
    assert.equal(deriveRawTopology(topologyInput).externalInputs.length, 1);

    const mutatedRaw = `${golden.rawTransaction.slice(0, -2)}${golden.rawTransaction.endsWith("00") ? "01" : "00"}`;
    expectCode("TOPOLOGY_EXTERNAL_TXID_MISMATCH", () => deriveRawTopology({
      ...topologyInput,
      inputManifest: {
        externalParents: [{
          rawTransaction: mutatedRaw,
          txid: golden.canonicalTxid,
        }],
      },
    }));

    const reversedTxid = Buffer.from(golden.canonicalTxid, "hex").reverse().toString("hex");
    const endianChild = serialize({
      inputs: [{ txid: reversedTxid, vout: 0, script: "51" }],
      outputs: [output(1_000, "51")],
    });
    expectCode("TOPOLOGY_EXTERNAL_PARENT_MISSING", () => deriveRawTopology({
      ...topologyInput,
      transactions: [{ role: "primary", finalizedRaw: endianChild }],
    }));
    expectCode("TOPOLOGY_EXTERNAL_TXID_MISMATCH", () => deriveRawTopology({
      ...topologyInput,
      inputManifest: {
        externalParents: [{
          rawTransaction: golden.rawTransaction,
          txid: reversedTxid,
        }],
      },
    }));

    expectCode("TOPOLOGY_EXTERNAL_PARENT_MISSING", () => deriveRawTopology({
      ...topologyInput,
      inputManifest: { externalParents: [] },
    }));
    expectCode("TOPOLOGY_EXTERNAL_PARENT_UNUSED", () => deriveRawTopology({
      ...topologyInput,
      inputManifest: {
        externalParents: [
          topologyInput.inputManifest.externalParents[0],
          external(0x70, "5170"),
        ],
      },
    }));
    expectCode("TOPOLOGY_EXTERNAL_TXID_DUPLICATE", () => deriveRawTopology({
      ...topologyInput,
      inputManifest: {
        externalParents: [
          topologyInput.inputManifest.externalParents[0],
          topologyInput.inputManifest.externalParents[0],
        ],
      },
    }));
    expectCode("TOPOLOGY_EXTERNAL_METADATA_ONLY", () => deriveRawTopology({
      ...topologyInput,
      inputManifest: { externalParents: [{ txid: golden.canonicalTxid }] },
    }));

    const wrongVoutChild = serialize({
      inputs: [{ txid: golden.canonicalTxid, vout: 0xffff_ffff, script: "51" }],
      outputs: [output(1_000, "51")],
    });
    expectCode("TOPOLOGY_EXTERNAL_PARENT_VOUT", () => deriveRawTopology({
      ...topologyInput,
      transactions: [{ role: "primary", finalizedRaw: wrongVoutChild }],
    }));
  }

  const [source, core] = derivePair();
  assert.deepEqual(source.roles, ["maintenance", "maintenance", "primary"]);
  assert.deepEqual(source.edges, [
    { childPosition: 2, childRole: "primary", childInputIndex: 0, parentPosition: 0, parentRole: "maintenance", parentVout: 0 },
    { childPosition: 2, childRole: "primary", childInputIndex: 1, parentPosition: 1, parentRole: "maintenance", parentVout: 1 },
  ]);
  assert.equal(source.externalInputs.length, 2);
  assert.equal(core.externalInputs.length, 2);
  assert.deepEqual(compareRawTopologies(source, core), { ok: true, transactionCount: 3, internalEdgeCount: 2 });
});

test("raw topology rejects reordered internal edges", () => {
  const fixture = producerFixture("pinned-source", "01");
  const original = independentlyDeriveFixtureEdges(fixture);
  const reordered = structuredClone(original).reverse();
  assert.notDeepEqual(reordered, original, "edge array order must change");
  const membership = (edges) => edges.map((edge) => JSON.stringify(edge)).sort();
  assert.deepEqual(membership(reordered), membership(original), "edge membership and pairings must not change");
  for (const edge of original) {
    const match = reordered.find((candidate) => candidate.childInputIndex === edge.childInputIndex);
    assert.deepEqual(match, edge, `child input ${edge.childInputIndex} edge pairing changed`);
  }
  const roles = fixture.transactions.map(({ role }) => role);
  expectCode("TOPOLOGY_EDGE_ORDER", () => compareRawTopologies(
    { roles, edges: original, externalInputs: [] },
    { roles: [...roles], edges: reordered, externalInputs: [] },
  ));
});

test("raw topology distinguishes missing and extra internal edges", () => {
  const [source] = derivePair();
  const missing = producerFixture("production-core", "02");
  const replacement = external(0x30, "0230");
  missing.inputManifest.externalParents.push(replacement);
  missing.transactions[2].finalizedRaw = spend([
    { raw: missing.transactions[0].finalizedRaw, vout: 0 },
    { raw: replacement, vout: 1 },
  ], "0250", [output(6_000, "55")]);
  missing.declaredTransactions[2].dependsOn = ["merge-0"];
  expectCode("TOPOLOGY_EDGE_MISSING", () => compareRawTopologies(source, deriveRawTopology(missing)));

  const sourceMissing = producerFixture("pinned-source", "01");
  const sourceReplacement = external(0x31, "0131");
  sourceMissing.inputManifest.externalParents.push(sourceReplacement);
  sourceMissing.transactions[2].finalizedRaw = spend([
    { raw: sourceMissing.transactions[0].finalizedRaw, vout: 0 },
    { raw: sourceReplacement, vout: 1 },
  ], "0150", [output(6_000, "55")]);
  expectCode("TOPOLOGY_EDGE_EXTRA", () => compareRawTopologies(
    deriveRawTopology(sourceMissing),
    deriveRawTopology(producerFixture("production-core", "02")),
  ));
});

test("raw topology rejects a wrong internal parent vout", () => {
  const [source] = derivePair();
  const wrong = producerFixture("production-core", "02");
  wrong.transactions[2].finalizedRaw = spend([
    { raw: wrong.transactions[0].finalizedRaw, vout: 1 },
    { raw: wrong.transactions[1].finalizedRaw, vout: 1 },
  ], "0250", [output(6_000, "55")]);
  expectCode("TOPOLOGY_PARENT_VOUT", () => compareRawTopologies(source, deriveRawTopology(wrong)));
});

test("raw topology rejects forward raw edges and self declared edges", () => {
  const futureParent = external(0x40, "0240");
  const forwardChild = spend([{ raw: futureParent, vout: 0 }], "0260");
  expectCode("TOPOLOGY_FORWARD_EDGE", () => deriveRawTopology({
    producer: "pinned-source",
    scenario: "forward",
    transactions: [
      { role: "maintenance", finalizedRaw: forwardChild },
      { role: "primary", finalizedRaw: futureParent },
    ],
    inputManifest: { externalParents: [] },
  }));

  const self = producerFixture("production-core", "02");
  self.declaredTransactions[2].dependsOn = ["primary"];
  expectCode("DECLARED_DEPENDENCY_SELF", () => deriveRawTopology(self));
});

test("Process B declared dependencies must match direct raw internal parents", () => {
  const mismatch = producerFixture("production-core", "02");
  mismatch.declaredTransactions[2].dependsOn = ["merge-0"];
  expectCode("DECLARED_DEPENDENCY_MISMATCH", () => deriveRawTopology(mismatch));
});
