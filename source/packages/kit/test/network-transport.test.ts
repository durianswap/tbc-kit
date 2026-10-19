import { afterEach, describe, expect, it, vi } from "vitest";
import { createTbcHttpTransport, type TbcAttemptEvent } from "../src/network-transport.ts";
import { createTbcOfficialApi } from "../src/official-api.ts";
import { createTbcNodeAdminRpcClient } from "../src/official-rpc.ts";
import { createRequestLedger } from "../src/request-ledger.ts";

const baseUrl = "https://transport.example";
const json = (value: unknown = { ok: true }) => new Response(JSON.stringify(value));
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => { resolve = r; });
  return { promise, resolve };
}
const stalled = () => new Response(new ReadableStream<Uint8Array>({ start() {} }));
afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); });

describe("transport budgets and retries", () => {
  it("starts all independent reads immediately, merges duplicates, and never sleeps on success", async () => {
    vi.useFakeTimers();
    const gate = deferred<void>();
    const fetch = vi.fn(async () => { await gate.promise; return json(); });
    const ledger = createRequestLedger({ enabled: true });
    const client = createTbcHttpTransport({ baseUrl, fetch, ledger });
    const calls = Array.from({ length: 64 }, (_, index) => client.requestJson("GET", `item/${index}`));
    const duplicate = client.requestJson("GET", "item/0");
    expect(fetch).toHaveBeenCalledTimes(64); // Before advancing timers or yielding a microtask.
    gate.resolve();
    await Promise.all([...calls, duplicate]);
    expect(fetch).toHaveBeenCalledTimes(64);
    expect(ledger.snapshot().deduplicated).toBe(1);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("times out a stalled response body after headers, with no write retry", async () => {
    vi.useFakeTimers();
    const fetch = vi.fn(async () => stalled());
    const client = createTbcHttpTransport({ baseUrl, fetch, timeoutMs: 40 });
    const result = client.requestText("POST", "broadcast").catch((error) => error);
    await vi.advanceTimersByTimeAsync(40);
    expect(await result).toMatchObject({ code: "TIMEOUT" });
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("bounds a stalled header provider without network IO or retries", async () => {
    vi.useFakeTimers();
    const fetch = vi.fn();
    const client = createTbcHttpTransport({ baseUrl, fetch, timeoutMs: 100, totalTimeoutMs: 30,
      provideHeaders: () => new Promise(() => {}) });
    const result = client.requestText("GET", "slow-auth").catch((error) => error);
    await vi.advanceTimersByTimeAsync(30);
    expect(await result).toMatchObject({ code: "TIMEOUT", retryable: false });
    expect(fetch).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("bounds the entire retry sequence, including a later stalled body", async () => {
    vi.useFakeTimers();
    const fetch = vi.fn(async () => stalled());
    const client = createTbcHttpTransport({ baseUrl, fetch, timeoutMs: 30, totalTimeoutMs: 50,
      retryPolicy: { baseDelayMs: 5, jitter: "none" } });
    const result = client.requestText("GET", "slow-body").catch((error) => error);
    await vi.advanceTimersByTimeAsync(50);
    expect(await result).toMatchObject({ code: "TIMEOUT" });
    expect(fetch).toHaveBeenCalledTimes(2);
    expect(vi.getTimerCount()).toBe(0);
  });

  it.each(["2", new Date(Date.UTC(2030, 0, 1, 0, 0, 2)).toUTCString()])("never shortens Retry-After %s", async (header) => {
    vi.useFakeTimers(); vi.setSystemTime(Date.UTC(2030, 0, 1));
    let calls = 0;
    const fetch = vi.fn(async () => ++calls === 1
      ? new Response("limited", { status: 429, headers: { "retry-after": header } }) : json());
    const client = createTbcHttpTransport({ baseUrl, fetch, retryPolicy: { maxDelayMs: 100 } });
    const result = client.requestJson("GET", "limited");
    await vi.advanceTimersByTimeAsync(1_999);
    expect(fetch).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    await expect(result).resolves.toEqual({ ok: true });
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it("returns the limiting HTTP error immediately when Retry-After exceeds the remaining budget", async () => {
    const fetch = vi.fn(async () => new Response("limited", { status: 429, headers: { "retry-after": "30" } }));
    const client = createTbcHttpTransport({ baseUrl, fetch, totalTimeoutMs: 1_000 });
    await expect(client.requestText("GET", "limited")).rejects.toMatchObject({ code: "HTTP_ERROR", status: 429, retryAfterMs: 30_000 });
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it("applies configured attempt limits and jitter only after retryable failures", async () => {
    vi.useFakeTimers(); vi.spyOn(Math, "random").mockReturnValue(0.5);
    const events: TbcAttemptEvent[] = [];
    const fetch = vi.fn(async () => { throw new TypeError("disconnected"); });
    const client = createTbcHttpTransport({ baseUrl, fetch, retryPolicy: { maxAttempts: 3, baseDelayMs: 100 }, onAttempt: (e) => { events.push(e); } });
    const result = client.requestText("GET", "offline").catch((error) => error);
    await vi.advanceTimersByTimeAsync(150);
    expect(await result).toMatchObject({ code: "NETWORK_ERROR" });
    expect(fetch).toHaveBeenCalledTimes(3);
    expect(events.filter((e) => e.type === "retry").map((e) => e.delayMs)).toEqual([50, 100]);
    expect(events.filter((e) => e.type === "attempt")).toHaveLength(3);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("does not retry authentication-provider exceptions, ordinary HTTP errors, or invalid JSON", async () => {
    const provideHeaders = vi.fn(() => { throw new Error("auth failure"); });
    const fetch = vi.fn();
    await expect(createTbcHttpTransport({ baseUrl, fetch, provideHeaders }).requestText("GET", "auth")).rejects.toThrow("auth failure");
    expect(provideHeaders).toHaveBeenCalledTimes(1);
    expect(fetch).not.toHaveBeenCalled();
    for (const response of [new Response("bad", { status: 400 }), new Response("not-json")]) {
      const fetch = vi.fn(async () => response);
      await expect(createTbcHttpTransport({ baseUrl, fetch }).requestJson("GET", "bad")).rejects.toBeDefined();
      expect(fetch).toHaveBeenCalledTimes(1);
    }
  });

  it("keeps public API and RPC writes single attempt despite configured retries", async () => {
    const fetch = vi.fn(async () => new Response("temporary", { status: 503 }));
    const api = createTbcOfficialApi({ baseUrl, fetch, retryPolicy: { maxAttempts: 10 } });
    await expect(api.broadcastTransaction({ txraw: "00" }, { retry: "idempotent-read" })).rejects.toMatchObject({ status: 503 });
    const rpc = createTbcNodeAdminRpcClient({ url: baseUrl, fetch, trustedServer: true, retryPolicy: { maxAttempts: 10 } });
    await expect(rpc.stop({ retry: "idempotent-read" })).rejects.toMatchObject({ status: 503 });
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it("rejects oversize streamed bytes without waiting for the remaining body", async () => {
    const cancel = vi.fn();
    const fetch = vi.fn(async () => new Response(new ReadableStream({
      start(controller) { controller.enqueue(new Uint8Array(17)); }, cancel,
    })));
    const client = createTbcHttpTransport({ baseUrl, fetch, maxResponseBytes: 16 });
    await expect(client.requestText("GET", "large")).rejects.toMatchObject({ code: "RESPONSE_TOO_LARGE" });
    expect(cancel).toHaveBeenCalledTimes(1);
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it("decodes UTF-8 across chunk boundaries", async () => {
    const bytes = new TextEncoder().encode('{"label":"榴莲"}');
    const fetch = async () => new Response(new ReadableStream({ start(controller) {
      for (const byte of bytes) controller.enqueue(Uint8Array.of(byte));
      controller.close();
    } }));
    await expect(createTbcHttpTransport({ baseUrl, fetch }).requestJson("GET", "utf8")).resolves.toEqual({ label: "榴莲" });
  });

  it("rejects a declared oversize body before starting to consume it", async () => {
    const cancel = vi.fn();
    const fetch = async () => new Response(new ReadableStream({ cancel }), { headers: { "content-length": "1024" } });
    await expect(createTbcHttpTransport({ baseUrl, fetch, maxResponseBytes: 16 }).requestText("GET", "large"))
      .rejects.toMatchObject({ code: "RESPONSE_TOO_LARGE" });
    expect(cancel).toHaveBeenCalledTimes(1);
  });

  it("still bounds text-only native adapters that do not implement streaming", async () => {
    vi.useFakeTimers();
    const response = { ok: true, status: 200, url: "", headers: new Headers(), text: () => new Promise<string>(() => {}) };
    const client = createTbcHttpTransport({ baseUrl, timeoutMs: 20, fetch: async () => response as Response });
    const result = client.requestText("GET", "native", undefined, { retry: "none" }).catch((e) => e);
    await vi.advanceTimersByTimeAsync(20);
    expect(await result).toMatchObject({ code: "TIMEOUT" });
    expect(vi.getTimerCount()).toBe(0);
  });

  it("isolates observation failures and emits no credentials or bodies", async () => {
    const events: TbcAttemptEvent[] = [];
    const client = createTbcHttpTransport({ baseUrl, fetch: async () => json(), headers: { authorization: "secret" },
      onAttempt: (event) => { events.push(event); throw new Error("observer failure"); } });
    await expect(client.requestJson("POST", "broadcast", { secret: "payload" })).resolves.toEqual({ ok: true });
    expect(events).toHaveLength(1);
    expect(JSON.stringify(events)).not.toMatch(/secret|payload|authorization|https/);
  });
});

describe("single-flight ownership", () => {
  it("a subscriber without a signal keeps shared IO alive", async () => {
    const gate = deferred<Response>();
    let signal: AbortSignal;
    const fetch = vi.fn((_url: unknown, init?: RequestInit) => { signal = init!.signal!; return gate.promise; });
    const client = createTbcHttpTransport({ baseUrl, fetch });
    const controller = new AbortController();
    const cancellable = client.requestJson("GET", "same", undefined, { signal: controller.signal }).catch((e) => e);
    const persistent = client.requestJson("GET", "same");
    controller.abort();
    await cancellable;
    expect(signal!.aborted).toBe(false);
    gate.resolve(json());
    await expect(persistent).resolves.toEqual({ ok: true });
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it.each([0, 1])("caller %s can cancel without aborting another subscriber", async (cancelIndex) => {
    const gate = deferred<Response>();
    let signal: AbortSignal | undefined;
    const fetch = vi.fn((_url: unknown, init?: RequestInit) => { signal = init?.signal ?? undefined; return gate.promise; });
    const client = createTbcHttpTransport({ baseUrl, fetch });
    const controllers = [new AbortController(), new AbortController()];
    const calls = controllers.map((controller) => client.requestJson("GET", "same", undefined, { signal: controller.signal }).catch((error) => error));
    controllers[cancelIndex]!.abort(new Error("caller cancelled"));
    expect(await calls[cancelIndex]).toMatchObject({ message: "caller cancelled" });
    expect(signal?.aborted).toBe(false);
    gate.resolve(json());
    expect(await calls[1 - cancelIndex]).toEqual({ ok: true });
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it("aborts underlying IO when the last subscriber cancels, and a new caller starts fresh", async () => {
    const signals: AbortSignal[] = [];
    const fetch = vi.fn((_url: unknown, init?: RequestInit) => {
      signals.push(init!.signal!);
      return signals.length === 1 ? new Promise<Response>(() => {}) : Promise.resolve(json());
    });
    const client = createTbcHttpTransport({ baseUrl, fetch });
    const controllers = [new AbortController(), new AbortController()];
    const calls = controllers.map((c) => client.requestText("GET", "same", undefined, { signal: c.signal }).catch((e) => e));
    controllers.forEach((c) => c.abort());
    await Promise.all(calls);
    expect(signals[0]!.aborted).toBe(true);
    await expect(client.requestJson("GET", "same")).resolves.toEqual({ ok: true });
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it("isolates instances and retry policies even with a shared ledger", async () => {
    const ledger = createRequestLedger({ enabled: true });
    const gate = deferred<void>();
    const fetch = vi.fn(async (_url: unknown, init?: RequestInit) => {
      await gate.promise; return json({ auth: (init!.headers as Record<string, string>).authorization });
    });
    const first = createTbcHttpTransport({ baseUrl, fetch, ledger, headers: { authorization: "first" } });
    const second = createTbcHttpTransport({ baseUrl, fetch, ledger, headers: { authorization: "second" } });
    const calls = [first.requestJson("GET", "same"), second.requestJson("GET", "same"), first.requestJson("GET", "same", undefined, { retry: "none" })];
    expect(fetch).toHaveBeenCalledTimes(3);
    gate.resolve();
    expect(await Promise.all(calls)).toEqual([{ auth: "first" }, { auth: "second" }, { auth: "first" }]);
  });

  it("does not share responses across dynamic credential changes", async () => {
    let auth = "first";
    const gate = deferred<void>();
    const fetch = vi.fn(async (_url: unknown, init?: RequestInit) => {
      await gate.promise; return json({ auth: (init!.headers as Record<string, string>).authorization });
    });
    const client = createTbcHttpTransport({ baseUrl, fetch, provideHeaders: () => ({ authorization: auth }) });
    const first = client.requestJson("GET", "same");
    auth = "second";
    const second = client.requestJson("GET", "same");
    gate.resolve();
    expect(await Promise.all([first, second])).toEqual([{ auth: "first" }, { auth: "second" }]);
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it("cancels retry waiting immediately and does not issue another request", async () => {
    vi.useFakeTimers();
    const controller = new AbortController();
    const fetch = vi.fn(async () => new Response("busy", { status: 503, headers: { "retry-after": "10" } }));
    const client = createTbcHttpTransport({ baseUrl, fetch });
    const result = client.requestText("GET", "same", undefined, { signal: controller.signal }).catch((e) => e);
    await vi.advanceTimersByTimeAsync(1);
    controller.abort(new Error("stop waiting"));
    expect(await result).toMatchObject({ message: "stop waiting" });
    await vi.advanceTimersByTimeAsync(20_000);
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);
  });
});
