import {
  assertValidTws,
  canonicalize,
  hashCanonical,
  type BroadcastSubmitResult,
} from "./core-runtime.js";
import type { KitSqliteDriver, KitSqliteTransaction, KitSqliteValue } from "./sqlite.js";

export type TbcKitBroadcastJournalSchema = "kit-v1" | "legacy-tws-mobile-v1";

export interface TbcKitBroadcastIdentity {
  readonly idempotencyKey: string;
  readonly rawHash: string;
  readonly txid: string;
  /** Digest of the exact trusted Host submit call. Older journal rows omit it. */
  readonly submitContextHash?: string;
  /** Digest of the wallet-owned active account scope. Older rows omit it. */
  readonly accountScopeHash?: string;
}

export interface TbcKitBroadcastPreparation {
  readonly record: TbcKitBroadcastJournalRecord;
  /** True only for the caller that atomically created this submit intent. */
  readonly created: boolean;
}

export interface TbcKitBroadcastBatchPreparation {
  /** Exact input order; null means another batch owns only part of this identity set. */
  readonly records: readonly (TbcKitBroadcastJournalRecord | null)[];
  /** True only when this caller atomically created every submit intent. */
  readonly created: boolean;
}

export interface TbcKitBroadcastJournalRecord extends TbcKitBroadcastIdentity {
  readonly state: "prepared" | "uncertain" | "completed" | "not-submitted";
  readonly createdAt: string;
  readonly result?: BroadcastSubmitResult;
}

export type TbcKitBroadcastPreNetworkAbortEvidence =
  | Readonly<{
      version: "1.0";
      kind: "local-preflight";
      failureCode: "INVALID_INPUT" | "NODE_RESPONSE_INVALID";
    }>
  | Readonly<{
      version: "1.0";
      kind: "historical-reconciliation";
      networkPostCount: 0;
      chainStatus: "unknown";
      observedInputs: readonly Readonly<{
        txid: string;
        vout: number;
        satoshis: string;
        unspent: true;
      }>[];
      tipHeight: string;
      tipHash: string;
      observedAt: string;
    }>;

export interface TbcKitBroadcastJournal {
  readonly beginSubmit: (identity: TbcKitBroadcastIdentity) => Promise<TbcKitBroadcastPreparation>;
  readonly beginSubmitBatch: (
    identities: readonly TbcKitBroadcastIdentity[],
  ) => Promise<TbcKitBroadcastBatchPreparation>;
  readonly prepare: (identity: TbcKitBroadcastIdentity) => Promise<TbcKitBroadcastJournalRecord>;
  readonly markUncertain: (identity: TbcKitBroadcastIdentity) => Promise<TbcKitBroadcastJournalRecord>;
  readonly complete: (
    identity: TbcKitBroadcastIdentity,
    result: BroadcastSubmitResult,
  ) => Promise<TbcKitBroadcastJournalRecord>;
  readonly abortPreNetwork: (
    identity: TbcKitBroadcastIdentity,
    evidence: TbcKitBroadcastPreNetworkAbortEvidence,
  ) => Promise<TbcKitBroadcastJournalRecord>;
  readonly read: (idempotencyKey: string) => Promise<TbcKitBroadcastJournalRecord | null>;
  readonly readByTxids: (txids: readonly string[]) => Promise<readonly TbcKitBroadcastJournalRecord[]>;
  readonly listIncomplete: (
    limit?: number,
    scope?: Readonly<{ idempotencyKeyPrefix?: string; accountScopeHash?: string }>,
  ) => Promise<readonly TbcKitBroadcastJournalRecord[]>;
}

export interface CreateTbcKitSqliteBroadcastJournalOptions {
  readonly driver: KitSqliteDriver;
  /** Use legacy mode to consume Mobile's existing three tables in place. */
  readonly schema?: TbcKitBroadcastJournalSchema;
  readonly now?: () => number;
}

export class TbcKitBroadcastConflictError extends Error {
  override readonly name = "TbcKitBroadcastConflictError";
}

const TABLES = Object.freeze({
  "kit-v1": Object.freeze({
    intents: "tbc_kit_broadcast_intents",
    results: "tbc_kit_broadcast_results",
    aborts: "tbc_kit_broadcast_aborts",
  }),
  "legacy-tws-mobile-v1": Object.freeze({
    intents: "tws_mobile_broadcast_intents",
    results: "tws_mobile_broadcast_results",
    aborts: "tws_mobile_broadcast_aborts",
  }),
});

function canonicalTime(now: () => number): string {
  const value = now();
  if (!Number.isFinite(value)) throw new TbcKitBroadcastConflictError("Invalid broadcast clock");
  return new Date(value).toISOString();
}

function frozenClone<T>(value: T): T {
  const cloned = JSON.parse(canonicalize(value)) as T;
  const freeze = (item: unknown): void => {
    if (item !== null && typeof item === "object" && !Object.isFrozen(item)) {
      for (const child of Object.values(item as Record<string, unknown>)) freeze(child);
      Object.freeze(item);
    }
  };
  freeze(cloned);
  return cloned;
}

function parseCanonical<T>(value: string): T {
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch {
    throw new TbcKitBroadcastConflictError("Corrupt broadcast canonical JSON");
  }
  if (canonicalize(parsed) !== value) {
    throw new TbcKitBroadcastConflictError("Non-canonical broadcast JSON");
  }
  return frozenClone(parsed) as T;
}

function sameIdentity(left: TbcKitBroadcastIdentity, right: TbcKitBroadcastIdentity): boolean {
  const project = (value: TbcKitBroadcastIdentity) => ({
    idempotencyKey: value.idempotencyKey,
    rawHash: value.rawHash,
    txid: value.txid,
    ...(value.submitContextHash === undefined ? {} : { submitContextHash: value.submitContextHash }),
    ...(value.accountScopeHash === undefined ? {} : { accountScopeHash: value.accountScopeHash }),
  });
  return canonicalize(project(left)) === canonicalize(project(right));
}

function checkedIdentity(input: TbcKitBroadcastIdentity): TbcKitBroadcastIdentity {
  const identity = frozenClone({
    idempotencyKey: input.idempotencyKey,
    rawHash: input.rawHash,
    txid: input.txid,
    ...(input.submitContextHash === undefined ? {} : { submitContextHash: input.submitContextHash }),
    ...(input.accountScopeHash === undefined ? {} : { accountScopeHash: input.accountScopeHash }),
  });
  if (
    identity.idempotencyKey.length === 0 ||
    identity.idempotencyKey.length > 256 ||
    !/^[0-9a-f]{64}$/u.test(identity.rawHash) ||
    !/^[0-9a-f]{64}$/u.test(identity.txid) ||
    (identity.submitContextHash !== undefined && !/^[0-9a-f]{64}$/u.test(identity.submitContextHash)) ||
    (identity.accountScopeHash !== undefined && !/^[0-9a-f]{64}$/u.test(identity.accountScopeHash))
  ) {
    throw new TbcKitBroadcastConflictError("Invalid broadcast identity");
  }
  return identity;
}

export async function createTbcKitSqliteBroadcastJournal(
  options: CreateTbcKitSqliteBroadcastJournalOptions,
): Promise<TbcKitBroadcastJournal> {
  if (options === null || typeof options !== "object" || options.driver?.dialect !== "sqlite") {
    throw new TypeError("A Kit SQLite driver is required for durable broadcast recovery");
  }
  const schema = options.schema ?? "kit-v1";
  const tables = TABLES[schema];
  if (tables === undefined) throw new TypeError("Unsupported Kit broadcast journal schema");
  const now = options.now ?? Date.now;

  await options.driver.transaction(async (transaction) => {
    await transaction.run(`CREATE TABLE IF NOT EXISTS ${tables.intents} (
      idempotency_key TEXT PRIMARY KEY,
      raw_hash TEXT NOT NULL,
      txid TEXT NOT NULL,
      state TEXT NOT NULL CHECK (state IN ('prepared', 'uncertain', 'completed')),
      canonical_json TEXT NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    ) STRICT`);
    await transaction.run(`CREATE TABLE IF NOT EXISTS ${tables.results} (
      idempotency_key TEXT PRIMARY KEY,
      raw_hash TEXT NOT NULL,
      txid TEXT NOT NULL,
      status TEXT NOT NULL,
      result_digest TEXT NOT NULL,
      canonical_json TEXT NOT NULL,
      created_at TEXT NOT NULL,
      FOREIGN KEY (idempotency_key) REFERENCES ${tables.intents}(idempotency_key)
    ) STRICT`);
    await transaction.run(`CREATE TABLE IF NOT EXISTS ${tables.aborts} (
      idempotency_key TEXT PRIMARY KEY,
      raw_hash TEXT NOT NULL,
      txid TEXT NOT NULL,
      kind TEXT NOT NULL CHECK (kind IN ('local-preflight', 'historical-reconciliation')),
      evidence_digest TEXT NOT NULL,
      canonical_json TEXT NOT NULL,
      created_at TEXT NOT NULL,
      FOREIGN KEY (idempotency_key) REFERENCES ${tables.intents}(idempotency_key)
    ) STRICT`);
    const intentColumns = await transaction.all(`PRAGMA table_info(${tables.intents})`);
    if (!intentColumns.some((column) => column.name === "submit_context_hash")) {
      await transaction.run(`ALTER TABLE ${tables.intents} ADD COLUMN submit_context_hash TEXT`);
    }
    if (!intentColumns.some((column) => column.name === "account_scope_hash")) {
      await transaction.run(`ALTER TABLE ${tables.intents} ADD COLUMN account_scope_hash TEXT`);
    }
  });

  async function readWithin(
    transaction: KitSqliteTransaction,
    idempotencyKey: string,
  ): Promise<TbcKitBroadcastJournalRecord | null> {
    const row = await transaction.get(
      `SELECT i.idempotency_key, i.raw_hash, i.txid, i.state, i.canonical_json, i.created_at,
              i.submit_context_hash, i.account_scope_hash,
              r.raw_hash AS result_raw_hash, r.txid AS result_txid, r.status,
              r.result_digest, r.canonical_json AS result_canonical_json,
              a.raw_hash AS abort_raw_hash, a.txid AS abort_txid,
              a.kind AS abort_kind, a.evidence_digest AS abort_evidence_digest,
              a.canonical_json AS abort_canonical_json
       FROM ${tables.intents} i
       LEFT JOIN ${tables.results} r ON r.idempotency_key = i.idempotency_key
       LEFT JOIN ${tables.aborts} a ON a.idempotency_key = i.idempotency_key
       WHERE i.idempotency_key = :idempotencyKey`,
      { idempotencyKey },
    );
    if (row === null) return null;
    if (typeof row.canonical_json !== "string" || typeof row.created_at !== "string") {
      throw new TbcKitBroadcastConflictError("Corrupt broadcast intent");
    }
    const identity = checkedIdentity(parseCanonical<TbcKitBroadcastIdentity>(row.canonical_json));
    if (
      row.idempotency_key !== identity.idempotencyKey ||
      row.raw_hash !== identity.rawHash ||
      row.txid !== identity.txid ||
      row.submit_context_hash !== (identity.submitContextHash ?? null) ||
      row.account_scope_hash !== (identity.accountScopeHash ?? null)
    ) {
      throw new TbcKitBroadcastConflictError("Corrupt broadcast identity");
    }
    if (row.state === "prepared" || row.state === "uncertain") {
      if (row.result_canonical_json !== null || row.abort_canonical_json !== null) {
        throw new TbcKitBroadcastConflictError("Impossible broadcast journal state");
      }
      return Object.freeze({ ...identity, state: row.state, createdAt: row.created_at });
    }
    if (
      row.state !== "completed" ||
      typeof row.result_canonical_json !== "string" ||
      typeof row.result_digest !== "string" ||
      row.result_raw_hash !== identity.rawHash ||
      row.result_txid !== identity.txid
    ) {
      throw new TbcKitBroadcastConflictError("Impossible broadcast journal state");
    }
    const result = parseCanonical<BroadcastSubmitResult>(row.result_canonical_json);
    assertValidTws("broadcastSubmitResult", result);
    if (
      result.txid !== identity.txid ||
      row.status !== result.status ||
      row.result_digest !== hashCanonical(result)
    ) {
      throw new TbcKitBroadcastConflictError("Corrupt broadcast result");
    }
    if (row.abort_canonical_json !== null) {
      if (
        typeof row.abort_canonical_json !== "string" ||
        typeof row.abort_evidence_digest !== "string" ||
        row.abort_raw_hash !== identity.rawHash ||
        row.abort_txid !== identity.txid ||
        (row.abort_kind !== "local-preflight" && row.abort_kind !== "historical-reconciliation") ||
        row.abort_evidence_digest !== hashCanonical(parseCanonical(row.abort_canonical_json)) ||
        result.status !== "rejected" ||
        result.reason !== "TBC Testnet transaction was not submitted"
      ) {
        throw new TbcKitBroadcastConflictError("Corrupt broadcast abort");
      }
      return Object.freeze({ ...identity, state: "not-submitted", createdAt: row.created_at, result });
    }
    return Object.freeze({ ...identity, state: "completed", createdAt: row.created_at, result });
  }

  async function read(idempotencyKey: string): Promise<TbcKitBroadcastJournalRecord | null> {
    return options.driver.transaction((transaction) => readWithin(transaction, idempotencyKey));
  }

  async function beginSubmitBatch(
    inputs: readonly TbcKitBroadcastIdentity[],
  ): Promise<TbcKitBroadcastBatchPreparation> {
    if (!Array.isArray(inputs) || inputs.length < 1 || inputs.length > 32) {
      throw new TbcKitBroadcastConflictError("Invalid broadcast batch identity count");
    }
    const identities = inputs.map(checkedIdentity);
    if (
      new Set(identities.map(({ idempotencyKey }) => idempotencyKey)).size !== identities.length ||
      new Set(identities.map(({ rawHash }) => rawHash)).size !== identities.length ||
      new Set(identities.map(({ txid }) => txid)).size !== identities.length
    ) {
      throw new TbcKitBroadcastConflictError("Duplicate broadcast batch identity");
    }
    return options.driver.transaction(async (transaction) => {
      const existing: (TbcKitBroadcastJournalRecord | null)[] = [];
      for (const identity of identities) {
        const record = await readWithin(transaction, identity.idempotencyKey);
        if (record !== null && !sameIdentity(record, identity)) {
          throw new TbcKitBroadcastConflictError("Broadcast idempotency collision");
        }
        existing.push(record);
      }
      if (existing.some((record) => record !== null)) {
        return Object.freeze({ records: Object.freeze(existing), created: false });
      }
      for (const identity of identities) {
        const collisions = await transaction.all(
          `SELECT idempotency_key FROM ${tables.intents}
           WHERE txid = :txid OR raw_hash = :rawHash ORDER BY idempotency_key`,
          { txid: identity.txid, rawHash: identity.rawHash },
        );
        for (const collision of collisions) {
          if (typeof collision.idempotency_key !== "string") {
            throw new TbcKitBroadcastConflictError("Corrupt broadcast key");
          }
          const record = await readWithin(transaction, collision.idempotency_key);
          if (record?.state !== "not-submitted") {
            throw new TbcKitBroadcastConflictError("Broadcast transaction identity already journaled");
          }
        }
      }
      const createdAt = canonicalTime(now);
      const records: TbcKitBroadcastJournalRecord[] = [];
      for (const identity of identities) {
        await transaction.run(
          `INSERT INTO ${tables.intents}
           (idempotency_key, raw_hash, txid, state, canonical_json, created_at, updated_at,
            submit_context_hash, account_scope_hash)
           VALUES (:idempotencyKey, :rawHash, :txid, 'prepared', :canonicalJson, :createdAt, :createdAt,
            :submitContextHash, :accountScopeHash)`,
          {
            idempotencyKey: identity.idempotencyKey,
            rawHash: identity.rawHash,
            txid: identity.txid,
            canonicalJson: canonicalize(identity),
            createdAt,
            submitContextHash: identity.submitContextHash ?? null,
            accountScopeHash: identity.accountScopeHash ?? null,
          },
        );
        records.push(Object.freeze({ ...identity, state: "prepared", createdAt }));
      }
      return Object.freeze({ records: Object.freeze(records), created: true });
    });
  }

  async function beginSubmit(input: TbcKitBroadcastIdentity): Promise<TbcKitBroadcastPreparation> {
    const preparation = await beginSubmitBatch([input]);
    const record = preparation.records[0];
    if (record === null || record === undefined) {
      throw new TbcKitBroadcastConflictError("Missing broadcast preparation");
    }
    return Object.freeze({ record, created: preparation.created });
  }

  async function prepare(input: TbcKitBroadcastIdentity): Promise<TbcKitBroadcastJournalRecord> {
    return (await beginSubmit(input)).record;
  }

  async function markUncertain(input: TbcKitBroadcastIdentity): Promise<TbcKitBroadcastJournalRecord> {
    const identity = checkedIdentity(input);
    return options.driver.transaction(async (transaction) => {
      const existing = await readWithin(transaction, identity.idempotencyKey);
      if (existing === null || !sameIdentity(existing, identity)) {
        throw new TbcKitBroadcastConflictError("Broadcast uncertainty identity mismatch");
      }
      if (existing.state !== "prepared") return existing;
      const update = await transaction.run(
        `UPDATE ${tables.intents} SET state = 'uncertain', updated_at = :updatedAt
         WHERE idempotency_key = :idempotencyKey AND raw_hash = :rawHash AND state = 'prepared'`,
        { updatedAt: canonicalTime(now), idempotencyKey: identity.idempotencyKey, rawHash: identity.rawHash },
      );
      if (update.changes !== 1) throw new TbcKitBroadcastConflictError("Broadcast uncertainty CAS conflict");
      return Object.freeze({ ...existing, state: "uncertain" });
    });
  }

  async function complete(
    input: TbcKitBroadcastIdentity,
    resultInput: BroadcastSubmitResult,
  ): Promise<TbcKitBroadcastJournalRecord> {
    const identity = checkedIdentity(input);
    const result = frozenClone(resultInput);
    assertValidTws("broadcastSubmitResult", result);
    return options.driver.transaction(async (transaction) => {
      const existing = await readWithin(transaction, identity.idempotencyKey);
      if (existing === null || !sameIdentity(existing, identity) || result.txid !== identity.txid) {
        throw new TbcKitBroadcastConflictError("Broadcast completion identity mismatch");
      }
      if (existing.state === "completed") {
        if (canonicalize(existing.result) !== canonicalize(result)) {
          throw new TbcKitBroadcastConflictError("Broadcast result collision");
        }
        return existing;
      }
      if (existing.state === "not-submitted") throw new TbcKitBroadcastConflictError("Aborted broadcast cannot complete");
      const createdAt = canonicalTime(now);
      await transaction.run(
        `INSERT INTO ${tables.results}
         (idempotency_key, raw_hash, txid, status, result_digest, canonical_json, created_at)
         VALUES (:idempotencyKey, :rawHash, :txid, :status, :resultDigest, :canonicalJson, :createdAt)`,
        {
          idempotencyKey: identity.idempotencyKey,
          rawHash: identity.rawHash,
          txid: identity.txid,
          status: result.status,
          resultDigest: hashCanonical(result),
          canonicalJson: canonicalize(result),
          createdAt,
        },
      );
      const update = await transaction.run(
        `UPDATE ${tables.intents} SET state = 'completed', updated_at = :updatedAt
         WHERE idempotency_key = :idempotencyKey AND raw_hash = :rawHash
           AND state IN ('prepared', 'uncertain')`,
        { updatedAt: createdAt, idempotencyKey: identity.idempotencyKey, rawHash: identity.rawHash },
      );
      if (update.changes !== 1) throw new TbcKitBroadcastConflictError("Broadcast completion CAS conflict");
      return Object.freeze({ ...existing, state: "completed", result });
    });
  }

  async function abortPreNetwork(
    input: TbcKitBroadcastIdentity,
    evidenceInput: TbcKitBroadcastPreNetworkAbortEvidence,
  ): Promise<TbcKitBroadcastJournalRecord> {
    const identity = checkedIdentity(input);
    const evidence = frozenClone(evidenceInput);
    const observedInputKeys = evidence.kind === "historical-reconciliation"
      ? new Set(evidence.observedInputs.map((candidate) => `${candidate.txid}:${candidate.vout}`))
      : undefined;
    if (
      evidence.version !== "1.0" ||
      (evidence.kind === "local-preflight"
        ? evidence.failureCode !== "INVALID_INPUT" && evidence.failureCode !== "NODE_RESPONSE_INVALID"
        : evidence.kind !== "historical-reconciliation" ||
          evidence.networkPostCount !== 0 ||
          evidence.chainStatus !== "unknown" ||
          evidence.observedInputs.length === 0 ||
          evidence.observedInputs.length > 64 ||
          observedInputKeys?.size !== evidence.observedInputs.length ||
          evidence.observedInputs.some((candidate) =>
            !/^[0-9a-f]{64}$/u.test(candidate.txid) ||
            !Number.isSafeInteger(candidate.vout) || candidate.vout < 0 ||
            !/^[1-9][0-9]*$/u.test(candidate.satoshis) || candidate.unspent !== true) ||
          !/^(?:0|[1-9][0-9]*)$/u.test(evidence.tipHeight) ||
          !/^[0-9a-f]{64}$/u.test(evidence.tipHash) ||
          !Number.isFinite(Date.parse(evidence.observedAt)))
    ) {
      throw new TbcKitBroadcastConflictError("Invalid pre-network abort evidence");
    }
    return options.driver.transaction(async (transaction) => {
      const existing = await readWithin(transaction, identity.idempotencyKey);
      if (existing === null || !sameIdentity(existing, identity)) {
        throw new TbcKitBroadcastConflictError("Broadcast abort identity mismatch");
      }
      if (existing.state === "not-submitted") return existing;
      if (existing.state === "completed") throw new TbcKitBroadcastConflictError("Completed broadcast cannot be aborted");
      if (
        (evidence.kind === "local-preflight" && existing.state !== "prepared") ||
        (evidence.kind === "historical-reconciliation" && existing.state !== "uncertain")
      ) {
        throw new TbcKitBroadcastConflictError("Broadcast abort state contradicts its evidence");
      }
      const createdAt = canonicalTime(now);
      const result: BroadcastSubmitResult = Object.freeze({
        txid: identity.txid,
        status: "rejected",
        reason: "TBC Testnet transaction was not submitted",
      });
      await transaction.run(
        `INSERT INTO ${tables.aborts}
         (idempotency_key, raw_hash, txid, kind, evidence_digest, canonical_json, created_at)
         VALUES (:idempotencyKey, :rawHash, :txid, :kind, :evidenceDigest, :canonicalJson, :createdAt)`,
        {
          idempotencyKey: identity.idempotencyKey,
          rawHash: identity.rawHash,
          txid: identity.txid,
          kind: evidence.kind,
          evidenceDigest: hashCanonical(evidence),
          canonicalJson: canonicalize(evidence),
          createdAt,
        },
      );
      await transaction.run(
        `INSERT INTO ${tables.results}
         (idempotency_key, raw_hash, txid, status, result_digest, canonical_json, created_at)
         VALUES (:idempotencyKey, :rawHash, :txid, :status, :resultDigest, :canonicalJson, :createdAt)`,
        {
          idempotencyKey: identity.idempotencyKey,
          rawHash: identity.rawHash,
          txid: identity.txid,
          status: result.status,
          resultDigest: hashCanonical(result),
          canonicalJson: canonicalize(result),
          createdAt,
        },
      );
      const update = await transaction.run(
        `UPDATE ${tables.intents} SET state = 'completed', updated_at = :updatedAt
         WHERE idempotency_key = :idempotencyKey AND raw_hash = :rawHash
           AND state IN ('prepared', 'uncertain')`,
        { updatedAt: createdAt, idempotencyKey: identity.idempotencyKey, rawHash: identity.rawHash },
      );
      if (update.changes !== 1) throw new TbcKitBroadcastConflictError("Broadcast abort CAS conflict");
      return Object.freeze({ ...existing, state: "not-submitted", result });
    });
  }

  async function readByTxids(txids: readonly string[]): Promise<readonly TbcKitBroadcastJournalRecord[]> {
    if (txids.length === 0) return Object.freeze([]);
    if (txids.length > 32 || txids.some((txid) => !/^[0-9a-f]{64}$/u.test(txid))) {
      throw new TbcKitBroadcastConflictError("Invalid broadcast reconciliation identity");
    }
    return options.driver.transaction(async (transaction) => {
      const bindings = Object.fromEntries(txids.map((txid, index) => [`txid${index}`, txid]));
      const placeholders = txids.map((_, index) => `:txid${index}`).join(", ");
      const rows = await transaction.all(
        `SELECT idempotency_key FROM ${tables.intents}
         WHERE txid IN (${placeholders}) ORDER BY idempotency_key`,
        bindings,
      );
      const records: TbcKitBroadcastJournalRecord[] = [];
      for (const row of rows) {
        if (typeof row.idempotency_key !== "string") throw new TbcKitBroadcastConflictError("Corrupt broadcast key");
        const value = await readWithin(transaction, row.idempotency_key);
        if (value !== null) records.push(value);
      }
      return Object.freeze(records);
    });
  }

  async function listIncomplete(
    limit = 32,
    scope: Readonly<{ idempotencyKeyPrefix?: string; accountScopeHash?: string }> = {},
  ): Promise<readonly TbcKitBroadcastJournalRecord[]> {
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100) {
      throw new TbcKitBroadcastConflictError("Invalid broadcast recovery limit");
    }
    if (
      (scope.idempotencyKeyPrefix !== undefined && scope.idempotencyKeyPrefix.length === 0) ||
      (scope.accountScopeHash !== undefined && !/^[0-9a-f]{64}$/u.test(scope.accountScopeHash))
    ) throw new TbcKitBroadcastConflictError("Invalid broadcast recovery scope");
    return options.driver.transaction(async (transaction) => {
      const clauses = ["state IN ('prepared', 'uncertain')"];
      const bindings: Record<string, KitSqliteValue> = { limit };
      if (scope.idempotencyKeyPrefix !== undefined) {
        clauses.push("substr(idempotency_key, 1, :prefixLength) = :prefix");
        bindings.prefix = scope.idempotencyKeyPrefix;
        bindings.prefixLength = scope.idempotencyKeyPrefix.length;
      }
      if (scope.accountScopeHash !== undefined) {
        clauses.push("account_scope_hash = :accountScopeHash");
        bindings.accountScopeHash = scope.accountScopeHash;
      }
      const rows = await transaction.all(
        `SELECT idempotency_key FROM ${tables.intents}
         WHERE ${clauses.join(" AND ")} ORDER BY created_at, idempotency_key LIMIT :limit`,
        bindings,
      );
      const records: TbcKitBroadcastJournalRecord[] = [];
      for (const row of rows) {
        if (typeof row.idempotency_key !== "string") throw new TbcKitBroadcastConflictError("Corrupt broadcast key");
        const value = await readWithin(transaction, row.idempotency_key);
        if (value !== null) records.push(value);
      }
      return Object.freeze(records);
    });
  }

  return Object.freeze({
    beginSubmit,
    beginSubmitBatch,
    prepare,
    markUncertain,
    complete,
    abortPreNetwork,
    read,
    readByTxids,
    listIncomplete,
  });
}
