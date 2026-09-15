const test = require("node:test");
const assert = require("node:assert/strict");
const api = require("../lib/decart-api");
const presets = require("../lib/session-presets");

function reply(status, body) {
  const text = typeof body === "string" ? body : JSON.stringify(body);
  return { ok: status >= 200 && status < 300, status, text: async () => text, json: async () => JSON.parse(text) };
}

function fakeFetch(respond) {
  const impl = async (url, init) => {
    impl.calls.push({ url, init });
    return respond(url, init);
  };
  impl.calls = [];
  return impl;
}

test("asks for a 60-second token for one model, capped at a 10-minute session", async () => {
  const fetchImpl = fakeFetch(() => reply(200, { apiKey: "ek_test", expiresAt: "2026-09-15T10:00:00Z" }));
  const result = await api.createClientToken({ apiKey: "real-key", model: "lucy-2.5", fetchImpl });
  assert.deepEqual(result, { token: "ek_test", expiresAt: "2026-09-15T10:00:00Z" });

  const [{ url, init }] = fetchImpl.calls;
  assert.equal(url, "https://api.decart.ai/v1/client/tokens");
  assert.equal(init.method, "POST");
  assert.equal(init.headers["x-api-key"], "real-key");
  assert.deepEqual(JSON.parse(init.body), {
    expiresIn: 60,
    allowedModels: ["lucy-2.5"],
    constraints: { realtime: { maxSessionDuration: 600 } }
  });
});

test("only the two models Miko maps to can get a token", async () => {
  assert.deepEqual([...api.DECART_MODELS].sort(), Object.values(presets.DECART_MODELS).sort());
  const fetchImpl = fakeFetch(() => reply(200, { apiKey: "ek_test" }));
  await assert.rejects(api.createClientToken({ apiKey: "k", model: "lucy-latest", fetchImpl }), /doesn't use the model "lucy-latest"/);
  await assert.rejects(api.createClientToken({ apiKey: "", model: "lucy-2.5", fetchImpl }), /No API key configured/);
  assert.equal(fetchImpl.calls.length, 0, "nothing is sent for a model or key Miko wouldn't use");
});

test("token errors are precise: bad key, bad request, credits, rate limit, server error, network, empty reply", async () => {
  const cases = [
    [reply(401, { error: "Invalid or expired API key" }), /The API key was rejected \(401: Invalid or expired API key\)\. Check it in Model settings → API key\.$/],
    [reply(422, { detail: [{ msg: "Field required" }] }), /refused to issue a session token \(422: Field required\)/],
    [reply(402, { error: "Insufficient credits" }), /run out of credits \(402: Insufficient credits\)/],
    [reply(429, { error: "Too many requests" }), /being rate limited \(429/],
    [reply(503, "upstream unavailable"), /service had an error \(503: upstream unavailable\)/],
    [reply(200, { expiresAt: "x" }), /had no token in it/]
  ];
  for (const [response, expected] of cases) {
    await assert.rejects(api.createClientToken({ apiKey: "k", model: "lucy-vton-3.5", fetchImpl: async () => response }), expected);
  }
  const offline = async () => { throw Object.assign(new TypeError("fetch failed"), { cause: { code: "ENOTFOUND" } }); };
  await assert.rejects(api.createClientToken({ apiKey: "k", model: "lucy-2.5", fetchImpl: offline }), /Could not reach the realtime service to request a session token \(network error: ENOTFOUND\)\.$/);
});

test("reads the live-session quota, and says so when the key is refused", async () => {
  const fetchImpl = fakeFetch(() => reply(200, { limit: 2, active: 1, remaining: 1 }));
  assert.deepEqual(await api.getRealtimeQuota({ apiKey: "k", fetchImpl }), { limit: 2, active: 1, remaining: 1 });
  assert.equal(fetchImpl.calls[0].url, "https://api.decart.ai/v1/realtime/quota");
  assert.equal(fetchImpl.calls[0].init.headers["x-api-key"], "k");

  const unlimited = await api.getRealtimeQuota({ apiKey: "k", fetchImpl: async () => reply(200, { limit: null, active: null, remaining: null }) });
  assert.deepEqual(unlimited, { limit: null, active: null, remaining: null });

  await assert.rejects(api.getRealtimeQuota({ apiKey: "k", fetchImpl: async () => reply(401, { detail: "Invalid API key" }) }), /The API key was rejected \(401: Invalid API key\)/);
});
