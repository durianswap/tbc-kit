import assert from "node:assert/strict";
import test from "node:test";
import {
  TWS_HOST_PORT_NAMES,
  createMemoryTwsHostStore,
  createTwsHost,
} from "../dist/esm/index.js";
import { createPortCrashScenarios } from "./fixtures/port-scenarios.mjs";
import { TEST_LEASE_SCHEDULER } from "./fixtures/lease-scheduler.mjs";

const scenarios = await createPortCrashScenarios();

function deferred() {
  let resolve;
  const promise = new Promise((current) => {
    resolve = current;
  });
  return { promise, resolve };
}

function controlledScheduler(clock) {
  const tasks = [];
  let ordinal = 0;
  return Object.freeze({
    scheduleLeaseHeartbeat(delayMs, run) {
      const task = {
        ordinal: ++ordinal,
        dueAt: clock.value + delayMs,
        run,
        cancelled: false,
        fired: false,
      };
      tasks.push(task);
      return () => {
        task.cancelled = true;
      };
    },
    async fireNext() {
      const task = tasks
        .filter((item) => !item.cancelled && !item.fired)
        .sort((left, right) =>
          left.dueAt - right.dueAt || left.ordinal - right.ordinal
        )[0];
      assert.notEqual(task, undefined, "missing scheduled heartbeat");
      task.fired = true;
      clock.value = task.dueAt;
      task.run();
      for (let index = 0; index < 8; index += 1) await Promise.resolve();
      return task;
    },
  });
}

function targetFor(scenario, operation) {
  const index = scenario.transitions.findIndex(
    (transition) =>
      transition.kind === "waiting" &&
      transition.calls.some((call) => call.operation === operation),
  );
  assert.notEqual(index, -1, `missing ${operation}`);
  const transition = scenario.transitions[index];
  return {
    index,
    call: transition.calls.find((call) => call.operation === operation),
  };
}

async function seed(store, scenario, throughIndex) {
  const operationId = scenario.transitions[0].checkpoint.payload.operationId;
  const lease = await store.acquireLease({
    operationId,
    ownerId: "heartbeat-seed",
    ttlMs: 60_000,
  });
  let record = null;
  for (const transition of scenario.transitions.slice(0, throughIndex + 1)) {
    const committed = await store.commitTransition({
      lease,
      expected:
        record === null
          ? null
          : {
              storeRevision: record.storeRevision,
              checkpointHash: record.checkpointHash,
            },
      transition,
    });
    record = committed.operation;
  }
  await store.releaseLease({ lease });
  return operationId;
}

function authoritySource(scenario) {
  return Object.freeze({
    read: async () => structuredClone(scenario.authority),
    compareAndSwapSession: async () => {
      throw new Error("heartbeat tests do not reach a session commit");
    },
  });
}

function ports(handler) {
  return Object.freeze(
    Object.fromEntries(TWS_HOST_PORT_NAMES.map((name) => [name, handler])),
  );
}

function host({
  scenario,
  store,
  handler,
  leaseTtlMs,
  scheduleLeaseHeartbeat = TEST_LEASE_SCHEDULER.scheduleLeaseHeartbeat,
}) {
  return createTwsHost({
    core: scenario.createCore(),
    ports: ports(handler),
    store,
    authority: authoritySource(scenario),
    ownerId: "heartbeat-driver",
    scheduleLeaseHeartbeat,
    leaseTtlMs,
    maxSteps: 1,
  });
}

test("Host requires an explicit lease scheduler outside the nine Ports", () => {
  const scenario = scenarios.transaction;
  assert.throws(
    () =>
      createTwsHost({
        core: scenario.createCore(),
        ports: ports(async (call) => structuredClone(scenario.resultForCall(call))),
        store: createMemoryTwsHostStore(),
        authority: authoritySource(scenario),
        ownerId: "missing-lease-scheduler",
      }),
    /scheduleLeaseHeartbeat/,
  );
});

test("pre-dispatch renewal restores a full lease window before the first heartbeat", async () => {
  const scenario = scenarios.transaction;
  const target = targetFor(scenario, "chainData.resolve");
  const clock = { value: 0 };
  const base = createMemoryTwsHostStore({ now: () => clock.value });
  const operationId = await seed(base, scenario, target.index);
  let scheduled;
  let invocations = 0;
  let takeover;
  const store = Object.freeze({
    ...base,
    readOperation: async (id) => {
      const record = await base.readOperation(id);
      clock.value += 40;
      return record;
    },
    readCall: async (callId) => {
      const record = await base.readCall(callId);
      clock.value += 30;
      return record;
    },
    markCallUncertain: async (input) => {
      const record = await base.markCallUncertain(input);
      clock.value += 10;
      return record;
    },
  });
  const current = createTwsHost({
    core: scenario.createCore(),
    ports: ports(async (call) => {
      invocations += 1;
      clock.value += 11;
      assert.equal(clock.value < scheduled.dueAt, true);
      takeover = await base.acquireLease({
        operationId,
        ownerId: "premature-takeover",
        ttlMs: 90,
      });
      return structuredClone(scenario.resultForCall(call));
    }),
    store,
    authority: authoritySource(scenario),
    ownerId: "pre-dispatch-renewal",
    leaseTtlMs: 90,
    maxSteps: 1,
    scheduleLeaseHeartbeat: (delayMs, run) => {
      scheduled = { dueAt: clock.value + delayMs, run, cancelled: false };
      return () => {
        scheduled.cancelled = true;
      };
    },
  });

  const result = await current.resumeOperation({ operationId });

  assert.equal(result.status, "failed");
  assert.equal(result.error.code, "HOST_STEP_LIMIT");
  assert.equal(invocations, 1);
  assert.equal(takeover, null);
  assert.equal(scheduled.dueAt, 150);
  assert.equal(scheduled.cancelled, true);
  assert.equal((await base.readCall(target.call.callId)).status, "completed");
});

test("a failed pre-dispatch renewal leaves the call uncertain without invoking its Port", async () => {
  const scenario = scenarios.transaction;
  const target = targetFor(scenario, "chainData.resolve");
  const base = createMemoryTwsHostStore();
  const operationId = await seed(base, scenario, target.index);
  let renewals = 0;
  let invocations = 0;
  let completionWrites = 0;
  const store = Object.freeze({
    ...base,
    renewLease: async (input) => {
      renewals += 1;
      if (renewals === 2) {
        await base.releaseLease({ lease: input.lease });
      }
      return base.renewLease(input);
    },
    completeCall: async (input) => {
      completionWrites += 1;
      return base.completeCall(input);
    },
  });
  const current = host({
    scenario,
    store,
    leaseTtlMs: 90,
    handler: async (call) => {
      invocations += 1;
      return structuredClone(scenario.resultForCall(call));
    },
  });

  const result = await current.resumeOperation({ operationId });

  assert.equal(result.status, "failed");
  assert.equal(result.error.code, "HOST_STORE_CONFLICT");
  assert.equal(renewals, 2);
  assert.equal(invocations, 0);
  assert.equal(completionWrites, 0);
  assert.equal((await base.readCall(target.call.callId)).status, "uncertain");
});

for (const operation of [
  "approval.request",
  "chainData.resolve",
  "broadcast.submit",
]) {
  test(`${operation}: a Port slower than the lease TTL is invoked once and durably journaled`, async () => {
    const scenario = scenarios.transaction;
    const target = targetFor(scenario, operation);
    const clock = { value: 0 };
    const scheduler = controlledScheduler(clock);
    const store = createMemoryTwsHostStore({ now: () => clock.value });
    const operationId = await seed(store, scenario, target.index);
    const portStarted = deferred();
    const releasePort = deferred();
    let invocations = 0;
    const current = host({
      scenario,
      store,
      leaseTtlMs: 60,
      scheduleLeaseHeartbeat: scheduler.scheduleLeaseHeartbeat,
      handler: async (call) => {
        invocations += 1;
        portStarted.resolve();
        await releasePort.promise;
        return structuredClone(scenario.resultForCall(call));
      },
    });

    const running = current.resumeOperation({ operationId });
    await portStarted.promise;
    for (let heartbeat = 0; heartbeat < 4; heartbeat += 1) {
      await scheduler.fireNext();
    }
    assert.equal(
      await store.acquireLease({
        operationId,
        ownerId: "slow-port-takeover",
        ttlMs: 60,
      }),
      null,
    );
    releasePort.resolve();
    const result = await running;

    assert.equal(result.status, "failed");
    assert.equal(result.error.code, "HOST_STEP_LIMIT");
    assert.equal(invocations, 1);
    assert.equal((await store.readCall(target.call.callId)).status, "completed");
  });
}

test("a lost heartbeat fence prevents a returned Port result from being committed", async () => {
  const scenario = scenarios.transaction;
  const target = targetFor(scenario, "chainData.resolve");
  const clock = { value: 0 };
  const scheduler = controlledScheduler(clock);
  const base = createMemoryTwsHostStore({ now: () => clock.value });
  const operationId = await seed(base, scenario, target.index);
  const fenced = deferred();
  const portStarted = deferred();
  const releasePort = deferred();
  let renewals = 0;
  let completionWrites = 0;
  let takeover;
  const store = Object.freeze({
    ...base,
    renewLease: async (input) => {
      renewals += 1;
      if (renewals === 3) {
        assert.equal(await base.releaseLease({ lease: input.lease }), true);
        takeover = await base.acquireLease({
          operationId,
          ownerId: "replacement-driver",
          ttlMs: 5_000,
        });
        fenced.resolve();
      }
      return base.renewLease(input);
    },
    completeCall: async (input) => {
      completionWrites += 1;
      return base.completeCall(input);
    },
  });
  let invocations = 0;
  const current = host({
    scenario,
    store,
    leaseTtlMs: 90,
    scheduleLeaseHeartbeat: scheduler.scheduleLeaseHeartbeat,
    handler: async (call) => {
      invocations += 1;
      portStarted.resolve();
      await releasePort.promise;
      return structuredClone(scenario.resultForCall(call));
    },
  });

  const running = current.resumeOperation({ operationId });
  await portStarted.promise;
  await scheduler.fireNext();
  await fenced.promise;
  releasePort.resolve();
  const result = await running;

  assert.equal(result.status, "failed");
  assert.equal(result.error.code, "HOST_STORE_CONFLICT");
  assert.equal(invocations, 1);
  assert.equal(completionWrites, 0);
  assert.equal((await base.readCall(target.call.callId)).status, "uncertain");
  assert.equal(takeover.fencingToken, "3");
  await base.releaseLease({ lease: takeover });
});

test("Port completion stops the timer, drains an in-flight renew, and final-renews before commit", async () => {
  const scenario = scenarios.transaction;
  const target = targetFor(scenario, "approval.request");
  const clock = { value: 0 };
  const scheduler = controlledScheduler(clock);
  const base = createMemoryTwsHostStore({ now: () => clock.value });
  const operationId = await seed(base, scenario, target.index);
  const heartbeatStarted = deferred();
  const releaseHeartbeat = deferred();
  const portStarted = deferred();
  const releasePort = deferred();
  const portEnded = deferred();
  const events = [];
  let renewals = 0;
  let activeRenewals = 0;
  let maximumActiveRenewals = 0;
  let completionWrites = 0;
  const store = Object.freeze({
    ...base,
    renewLease: async (input) => {
      renewals += 1;
      const ordinal = renewals;
      activeRenewals += 1;
      maximumActiveRenewals = Math.max(maximumActiveRenewals, activeRenewals);
      events.push(`renew-start-${ordinal}`);
      try {
        if (ordinal === 3) {
          heartbeatStarted.resolve();
          await releaseHeartbeat.promise;
        }
        return await base.renewLease(input);
      } finally {
        events.push(`renew-end-${ordinal}`);
        activeRenewals -= 1;
      }
    },
    completeCall: async (input) => {
      completionWrites += 1;
      events.push("complete-call");
      return base.completeCall(input);
    },
  });
  let invocations = 0;
  const current = host({
    scenario,
    store,
    leaseTtlMs: 120,
    scheduleLeaseHeartbeat: scheduler.scheduleLeaseHeartbeat,
    handler: async (call) => {
      invocations += 1;
      events.push("port-start");
      portStarted.resolve();
      await releasePort.promise;
      events.push("port-end");
      portEnded.resolve();
      return structuredClone(scenario.resultForCall(call));
    },
  });

  const running = current.resumeOperation({ operationId });
  await portStarted.promise;
  await scheduler.fireNext();
  await heartbeatStarted.promise;
  releasePort.resolve();
  await portEnded.promise;
  assert.equal(invocations, 1);
  assert.equal(events.includes("renew-start-3"), true);
  assert.equal(events.includes("port-end"), true);
  assert.equal(completionWrites, 0);
  releaseHeartbeat.resolve();

  const result = await running;
  assert.equal(result.status, "failed");
  assert.equal(result.error.code, "HOST_STEP_LIMIT");
  assert.equal(renewals, 4);
  assert.equal(maximumActiveRenewals, 1);
  assert.equal(completionWrites, 1);
  assert.equal(events.indexOf("renew-end-3") < events.indexOf("renew-start-4"), true);
  assert.equal(events.indexOf("renew-end-4") < events.indexOf("complete-call"), true);
  assert.equal((await base.readCall(target.call.callId)).status, "completed");
});
