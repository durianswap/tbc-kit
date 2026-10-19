import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import { canonicalize } from "../scripts/lib/canonical-json.mjs";
import { readJson, repositoryRoot } from "../scripts/lib/repository.mjs";
import {
  projectApprovalRequester,
  validateTrustedContextSemantics,
} from "../scripts/lib/semantic-conformance.mjs";

const root = repositoryRoot(import.meta.url);
const vectors = readJson(root, "test-vectors/provider.json");

function contextHash(context) {
  return createHash("sha256")
    .update(Buffer.from(canonicalize(context), "utf8"))
    .digest("hex");
}

test("binds the canonical WebView context to a known hash", () => {
  const webview = vectors.trustedContexts.find(
    (vector) => vector.id === "webview-top-frame",
  );

  assert.deepEqual(webview.context, {
    sessionId: "session-transfer-1",
    transport: "webview",
    origin: "https://example.test",
    topOrigin: "https://example.test",
    frame: "top",
    navigationId: "nav-1",
    createdAt: "2026-08-31T12:00:00Z",
  });
  assert.equal(
    contextHash(webview.context),
    "761bc48d9bffdbb3f93c42896b61e6ba682b1ad661fb8c30c427ba07500d0ae6",
  );
  assert.equal(webview.contextHash, contextHash(webview.context));
});

test("changes contextHash when top origin, navigation or session changes", () => {
  const hashes = vectors.trustedContexts.map((vector) => vector.contextHash);

  assert.equal(new Set(hashes).size, hashes.length);
});

test("projects the approval requester without session or navigation identifiers", () => {
  const vector = vectors.trustedContexts[0];

  assert.deepEqual(
    projectApprovalRequester(vector.context),
    vector.approvalRequester,
  );
  assert.ok(!("sessionId" in vector.approvalRequester));
  assert.ok(!("navigationId" in vector.approvalRequester));
});

test("rejects a top frame whose origin differs from topOrigin", () => {
  const failure = vectors.trustedContextSemanticFailures.find(
    (vector) => vector.id === "top-frame-origin-mismatch",
  );

  assert.throws(
    () => validateTrustedContextSemantics(failure.context),
    new RegExp(failure.expectedViolation),
  );
});
