import assert from "node:assert/strict";
import { afterEach, describe, it, mock } from "node:test";
import { createLiveToken, createTokenHandler } from "../src/server.ts";

const request = (method = "POST") => new Request("https://clinic.example/api/karing/token", { method });

/** Stubs Karing's token endpoint and records what it was sent. */
const karing = (status: number, body: object = { token: "tok", expires_at: "2026-11-12T10:01:00.000Z" }) => {
  const calls: { url: string; auth: string | null }[] = [];
  mock.method(globalThis, "fetch", async (url: string, init: RequestInit) => {
    calls.push({ url, auth: new Headers(init.headers).get("authorization") });
    return new Response(JSON.stringify(body), { status });
  });
  return calls;
};

afterEach(() => mock.restoreAll());

describe("createTokenHandler", () => {
  it("refuses to be built without an authorize function or a key", () => {
    // @ts-expect-error: authorize is required
    assert.throws(() => createTokenHandler({ apiKey: "k" }), { reason: "forbidden" });
    assert.throws(() => createTokenHandler({ apiKey: "", authorize: () => true }), { reason: "unauthorized" });
  });

  it("gives a token only to a request your authorize lets through", async () => {
    const calls = karing(200);
    const handler = createTokenHandler({ apiKey: "secret-key", authorize: (r) => r.headers.get("x-user") === "staff" });
    assert.equal((await handler(request("GET"))).status, 405);
    assert.equal((await handler(request())).status, 401);
    assert.equal(calls.length, 0, "Karing is never asked for an unauthorized request");

    const ok = await handler(new Request("https://clinic.example/t", { method: "POST", headers: { "x-user": "staff" } }));
    assert.equal(ok.status, 200);
    assert.equal(ok.headers.get("cache-control"), "no-store");
    assert.deepEqual(await ok.json(), { token: "tok", expiresAt: "2026-11-12T10:01:00.000Z" });
    assert.deepEqual(calls, [{ url: "https://api.karing.ai/live-calls/token", auth: "Bearer secret-key" }]);
  });

  it("treats an authorize that throws as a no, and never passes Karing's errors on", async () => {
    karing(401, { error: "bad key secret-key" });
    const throwing = createTokenHandler({ apiKey: "k", authorize: () => { throw new Error("session store down"); } });
    assert.equal((await throwing(request())).status, 401);
    const response = await createTokenHandler({ apiKey: "secret-key", authorize: () => true })(request());
    assert.equal(response.status, 502);
    assert.ok(!(await response.text()).includes("secret-key"));
  });

  it("will not run in a browser", () => {
    Object.assign(globalThis, { document: {} });
    try {
      assert.throws(() => createTokenHandler({ apiKey: "k", authorize: () => true }), /server only/);
    } finally {
      delete (globalThis as { document?: unknown }).document;
    }
  });
});

describe("createLiveToken", () => {
  it("explains a refused key, and a malformed answer", async () => {
    karing(401);
    await assert.rejects(createLiveToken({ apiKey: "k" }), { reason: "unauthorized" });
    mock.restoreAll();
    karing(200, { token: 5 });
    await assert.rejects(createLiveToken({ apiKey: "k" }), { reason: "failed" });
  });
});
