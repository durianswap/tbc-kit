import { randomBytes, randomUUID } from "node:crypto";
import { verifySignIn } from "@tbc/kit";

// Local demonstration only. A production service must replace these Maps with
// durable storage offering an equivalent compare-and-set transaction.
const attempts = new Map();
const sessions = new Map();
const now = () => process.env.TBC_SIGN_IN_EXAMPLE_NOW ?? new Date().toISOString();

function seconds(timestamp) {
  return new Date(timestamp).toISOString().replace(/\.\d{3}Z$/u, "Z");
}

function sameChallenge(left, right) {
  return left.domain === right.domain &&
    left.uri === right.uri &&
    left.address === right.address &&
    left.chainId === right.chainId &&
    left.nonce === right.nonce &&
    left.issuedAt === right.issuedAt &&
    left.expirationTime === right.expirationTime &&
    left.statement === right.statement;
}

function issue(input) {
  const issuedAt = seconds(now());
  const attemptId = randomUUID();
  const fields = Object.freeze({
    domain: input.domain,
    uri: input.uri,
    address: input.address,
    chainId: input.chainId,
    nonce: randomBytes(24).toString("base64url"),
    issuedAt,
    expirationTime: seconds(Date.parse(issuedAt) + 5 * 60_000),
    statement: "Sign in to the local TBC Kit example",
  });
  attempts.set(attemptId, { state: "issued", fields });
  return { attemptId, fields };
}

async function verify(input) {
  const attempt = attempts.get(input.attemptId);
  if (attempt === undefined) throw new Error("Unknown login attempt");
  const verified = await verifySignIn({
    result: input.result,
    expected: {
      domain: attempt.fields.domain,
      uri: attempt.fields.uri,
      chainId: attempt.fields.chainId,
      address: attempt.fields.address,
      now: seconds(now()),
    },
    // This synchronous compare-and-set is atomic within this backend process.
    // Production code must implement the same issued -> consumed transition in
    // one durable database transaction and reject a zero-row update.
    consumeChallenge(challenge) {
      if (attempt.state !== "issued" || !sameChallenge(attempt.fields, challenge)) {
        return false;
      }
      attempt.state = "consumed";
      attempt.consumedAt = seconds(now());
      return true;
    },
  });

  // Session creation is a backend responsibility and happens only after both
  // cryptographic verification and successful atomic challenge consumption.
  const token = randomBytes(32).toString("base64url");
  const session = Object.freeze({
    token,
    accountId: `${verified.chainId}:${verified.address}`,
    createdAt: seconds(now()),
  });
  sessions.set(token, session);
  return session;
}

function inspect(attemptId) {
  const attempt = attempts.get(attemptId);
  if (attempt === undefined) throw new Error("Unknown login attempt");
  return {
    state: attempt.state,
    sessionCount: sessions.size,
  };
}

async function handle(message) {
  if (message.action === "issue") return issue(message.input);
  if (message.action === "verify") return await verify(message.input);
  if (message.action === "inspect") return inspect(message.input.attemptId);
  throw new Error("Unknown backend action");
}

process.on("message", async (message) => {
  try {
    process.send?.({ id: message.id, ok: true, value: await handle(message) });
  } catch (error) {
    process.send?.({
      id: message.id,
      ok: false,
      error: error instanceof Error ? error.message : String(error),
    });
  }
});
