const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");
const fs = require("node:fs");
const esbuild = require("esbuild");

const bundlePath = path.join(__dirname, `.miko-decart-session-test-${process.pid}.cjs`);
esbuild.buildSync({
  entryPoints: [path.join(__dirname, "../lib/decart-realtime-session.ts")],
  bundle: true,
  platform: "node",
  format: "cjs",
  outfile: bundlePath
});
const { DecartRealtimeSession, DECART_CONNECT_TIMEOUT_MS, DECART_FIRST_FRAME_TIMEOUT_MS } = require(bundlePath);
test.after(() => fs.rmSync(bundlePath, { force: true }));

class MockTrack {
  constructor() { this.kind = "video"; this.stopped = false; }
  stop() { this.stopped = true; }
}
class MockStream {
  constructor() { this.track = new MockTrack(); }
  getTracks() { return [this.track]; }
  getVideoTracks() { return [this.track]; }
}

// Streams built from given tracks; also stands in for the browser's MediaStream.
class TrackOf {
  constructor(kind) { this.kind = kind; this.stopped = false; }
  stop() { this.stopped = true; }
}
class StreamOf {
  constructor(tracks = []) { this.tracks = [...tracks]; }
  getTracks() { return this.tracks; }
  getVideoTracks() { return this.tracks.filter((track) => track.kind === "video"); }
  getAudioTracks() { return this.tracks.filter((track) => track.kind === "audio"); }
}

const REFERENCE = "data:image/jpeg;base64,AAAA";
let lastConstraints;

function installBrowserMocks() {
  Object.defineProperty(global, "navigator", {
    configurable: true,
    value: { mediaDevices: { getUserMedia: async (constraints) => { lastConstraints = constraints; return new MockStream(); } } }
  });
  global.window = { addEventListener() {} };
  global.MediaStream = StreamOf;
}

// A stand-in for @decartai/sdk that records what Miko asks of it.
function fakeSdk({ onConnect } = {}) {
  const log = { clients: [], connects: [] };
  const sdk = {
    models: { realtime: (name) => ({ name, urlPath: "/v1/stream", width: 1280, height: 720 }) },
    createDecartClient(options) {
      const client = {
        options,
        realtime: {
          connect: async (stream, connectOptions) => {
            const realtime = {
              sets: [],
              disconnected: 0,
              listeners: {},
              set: async (input) => { realtime.sets.push(input); },
              disconnect() { realtime.disconnected += 1; },
              on(event, listener) { (realtime.listeners[event] ||= []).push(listener); },
              emit(event, data) { (realtime.listeners[event] || []).forEach((listener) => listener(data)); }
            };
            log.connects.push({ stream, options: connectOptions, realtime });
            if (onConnect) return onConnect(connectOptions, realtime);
            queueMicrotask(() => connectOptions.onRemoteStream(new MockStream()));
            return realtime;
          }
        }
      };
      log.clients.push(client);
      return client;
    }
  };
  return { sdk, log };
}

function fakeBridge({ getToken } = {}) {
  const bridge = {
    tokens: [],
    logs: [],
    getToken: getToken || (async (model) => { bridge.tokens.push(model); return "ek_test"; }),
    logEvent: (level, message) => bridge.logs.push({ level, message })
  };
  return bridge;
}

function newSession({ sdk, bridge, guard } = {}) {
  const session = new DecartRealtimeSession("lucy-2.5", sdk, bridge);
  session.setConnectGuard(guard || (async () => {}));
  session.updateEditParams({ prompt: "Swap the person", referenceImageUrl: REFERENCE, enablePromptExpansion: true });
  return session;
}

const tick = () => new Promise((resolve) => setImmediate(resolve));

test("goes live with a short-lived token, the model's own size and usage data off", async () => {
  installBrowserMocks();
  const { sdk, log } = fakeSdk();
  const bridge = fakeBridge();
  let guardCalls = 0;
  const session = newSession({ sdk, bridge, guard: async ({ endpoint }) => { guardCalls += 1; assert.equal(endpoint, "lucy-2.5"); } });

  await session.connect();
  assert.equal(session.getSnapshot().state, "live");
  assert.ok(session.getSnapshot().remoteStream);
  assert.equal(guardCalls, 1);
  assert.deepEqual(bridge.tokens, ["lucy-2.5"]);
  assert.deepEqual(log.clients[0].options, { apiKey: "ek_test", telemetry: false });
  assert.equal(log.connects[0].options.model.name, "lucy-2.5");
  assert.deepEqual(log.connects[0].options.initialState, { prompt: { text: "Swap the person", enhance: true }, image: REFERENCE });
  assert.equal(lastConstraints.video.width.ideal, 1280);
  assert.equal(lastConstraints.video.height.ideal, 720);
  assert.equal(lastConstraints.audio, false);
  assert.ok(bridge.logs.some(({ message }) => /^Connected in \d+\.\ds — token \d+\.\ds · connected \d+\.\ds · video \d+\.\ds$/.test(message)), JSON.stringify(bridge.logs));
  session.hardStop();
});

test("a dropped connection stops the session instead of letting the SDK reconnect", async () => {
  installBrowserMocks();
  const { sdk, log } = fakeSdk();
  const session = newSession({ sdk, bridge: fakeBridge() });
  await session.connect();
  log.connects[0].options.onConnectionChange("reconnecting");

  const snap = session.getSnapshot();
  assert.equal(snap.state, "error");
  assert.match(snap.error, /connection dropped, so Miko stopped the session instead of reconnecting/);
  assert.equal(log.connects[0].realtime.disconnected, 1, "the SDK session is disposed, ending its retries");
  assert.equal(log.connects.length, 1, "no second connection");
});

test("not connected within 10 s: stopped, and a connection that completes late is closed", async (t) => {
  installBrowserMocks();
  let finishLate;
  const { sdk, log } = fakeSdk({
    onConnect: (_options, realtime) => new Promise((resolve) => { finishLate = () => resolve(realtime); })
  });
  const bridge = fakeBridge();
  const session = newSession({ sdk, bridge });

  t.mock.timers.enable({ apis: ["setTimeout"] });
  let settled = false;
  const connecting = session.connect().then(() => { settled = true; });
  for (let i = 0; i < 50 && !settled; i += 1) {
    await tick();
    t.mock.timers.tick(1000);
  }
  await connecting;
  t.mock.timers.reset();

  assert.equal(DECART_CONNECT_TIMEOUT_MS, 10000);
  assert.equal(session.getSnapshot().state, "error");
  assert.match(session.getSnapshot().error, /didn't connect within 10s/);
  assert.ok(bridge.logs.some(({ level, message }) => level === "warn" && /^Connect failed after \d+\.\ds — token \d+\.\ds · waiting on: connected \(timed out connecting\)$/.test(message)), JSON.stringify(bridge.logs));

  finishLate();
  await tick();
  assert.equal(log.connects[0].realtime.disconnected, 1, "the late connection is closed at once");
});

test("prompt and reference changes while live go out together, once they settle", async (t) => {
  installBrowserMocks();
  const { sdk, log } = fakeSdk();
  const session = newSession({ sdk, bridge: fakeBridge() });
  await session.connect();

  t.mock.timers.enable({ apis: ["setTimeout"] });
  session.updateEditParams({ prompt: "Swap the person into a knight" });
  session.updateEditParams({ prompt: "Swap the person into a knight in armour" });
  t.mock.timers.tick(299);
  assert.equal(log.connects[0].realtime.sets.length, 0, "waits for typing to settle");
  t.mock.timers.tick(1);
  t.mock.timers.reset();
  await tick();

  assert.deepEqual(log.connects[0].realtime.sets, [{ prompt: "Swap the person into a knight in armour", image: REFERENCE, enhance: true }]);
  session.hardStop();
});

test("Stop while the token is on its way never opens a connection", async () => {
  installBrowserMocks();
  let releaseToken;
  const { sdk, log } = fakeSdk();
  const bridge = fakeBridge({ getToken: () => new Promise((resolve) => { releaseToken = () => resolve("ek_late"); }) });
  const session = newSession({ sdk, bridge });

  const connecting = session.connect();
  for (let i = 0; i < 5 && !releaseToken; i += 1) await tick();
  session.disconnect();
  releaseToken();
  await connecting;
  await tick();

  assert.equal(log.clients.length, 0, "no client was created with the late token");
  assert.equal(session.getSnapshot().state, "idle");
});

test("a start check or token message is shown as written, and nothing connects", async () => {
  installBrowserMocks();
  const { sdk, log } = fakeSdk();
  const limited = newSession({ sdk, bridge: fakeBridge(), guard: async () => { throw new Error("Today's spending limit ($5.00) is reached."); } });
  await limited.connect();
  assert.equal(limited.getSnapshot().state, "error");
  assert.equal(limited.getSnapshot().error, "Today's spending limit ($5.00) is reached.");
  limited.hardStop();

  const refused = newSession({
    sdk,
    bridge: fakeBridge({ getToken: async () => { throw new Error("Error invoking remote method 'decart:get-token': Error: The API key was rejected (401: Invalid or expired API key). Check it in Model settings → API key."); } })
  });
  await refused.connect();
  assert.equal(refused.getSnapshot().error, "The API key was rejected (401: Invalid or expired API key). Check it in Model settings → API key.");
  assert.equal(log.clients.length, 0);
  refused.hardStop();
});

test("the service ending a session at its time cap is explained, and billed seconds are kept", async () => {
  installBrowserMocks();
  const { sdk, log } = fakeSdk();
  const bridge = fakeBridge();
  const session = newSession({ sdk, bridge });
  await session.connect();
  const { realtime, options } = log.connects[0];

  realtime.emit("generationTick", { seconds: 42 });
  assert.equal(session.getBilledSeconds(), 42);
  realtime.emit("generationEnded", { seconds: 600, reason: "max_session_duration" });
  options.onConnectionChange("disconnected");

  assert.equal(session.getSnapshot().state, "error");
  assert.match(session.getSnapshot().error, /reached its 10-minute limit/);
  assert.equal(session.getBilledSeconds(), 600);
  assert.ok(bridge.logs.some(({ message }) => message === "The service reported 600 s of generation for this session"));
});

test("the video is shown even when the service's audio arrives first, and the newest video track wins", async () => {
  installBrowserMocks();
  const audio = new TrackOf("audio");
  const video = new TrackOf("video");
  const { sdk, log } = fakeSdk({
    onConnect: (options, realtime) => {
      queueMicrotask(() => {
        options.onRemoteStream(new StreamOf([audio]));
        options.onRemoteStream(new StreamOf([audio, video]));
      });
      return realtime;
    }
  });
  const session = newSession({ sdk, bridge: fakeBridge() });
  await session.connect();

  const shown = session.getSnapshot().remoteStream;
  assert.equal(session.getSnapshot().state, "live");
  assert.deepEqual(shown.getTracks(), [video], "only the video track, so the result player never plays audio");

  log.connects[0].options.onRemoteStream(new StreamOf([audio, video]));
  assert.equal(session.getSnapshot().remoteStream, shown, "the same video track doesn't rebind the player");

  const replacement = new TrackOf("video");
  log.connects[0].options.onRemoteStream(new StreamOf([audio, replacement]));
  assert.deepEqual(session.getSnapshot().remoteStream.getTracks(), [replacement], "a new video track is shown");
  session.hardStop();
});

test("once connected, the first frame gets 30 s more (unbilled until generation starts), then Miko gives up", async (t) => {
  installBrowserMocks();
  const { sdk, log } = fakeSdk({ onConnect: (_options, realtime) => realtime });
  const bridge = fakeBridge();
  const session = newSession({ sdk, bridge });

  t.mock.timers.enable({ apis: ["setTimeout"] });
  let settled = false;
  const connecting = session.connect().then(() => { settled = true; });
  for (let i = 0; i < 20; i += 1) {
    await tick();
    t.mock.timers.tick(1000);
  }
  assert.equal(session.getSnapshot().state, "connecting", "still waiting 20 s in: the old 10 s limit no longer applies once connected");
  for (let i = 0; i < 40 && !settled; i += 1) {
    await tick();
    t.mock.timers.tick(1000);
  }
  await connecting;
  t.mock.timers.reset();

  assert.equal(DECART_FIRST_FRAME_TIMEOUT_MS, 30000);
  assert.equal(session.getSnapshot().state, "error");
  assert.match(session.getSnapshot().error, /connected, but the first swapped frame didn't arrive within 30s/);
  assert.equal(log.connects[0].realtime.disconnected, 1);
  assert.ok(bridge.logs.some(({ message }) => /waiting on: generating \(timed out waiting for the first frame\)$/.test(message)), JSON.stringify(bridge.logs));
});

test("the log shows the queue, the start of generation and when each output track arrives", async () => {
  installBrowserMocks();
  const audio = new TrackOf("audio");
  const video = new TrackOf("video");
  const { sdk, log } = fakeSdk({
    onConnect: (options, realtime) => {
      queueMicrotask(() => {
        options.onQueuePosition({ position: 2, queueSize: 3 });
        options.onQueuePosition({ position: 2, queueSize: 3 });
        options.onRemoteStream(new StreamOf([audio]));
        options.onConnectionChange("generating");
        options.onRemoteStream(new StreamOf([audio, video]));
      });
      return realtime;
    }
  });
  const bridge = fakeBridge();
  const session = newSession({ sdk, bridge });
  await session.connect();
  await tick();
  // The real SDK holds events until a listener is attached; this fake
  // doesn't, so it sends the diagnostic once Miko is listening.
  log.connects[0].realtime.emit("diagnostic", { name: "client-session-connection-breakdown", data: { phases: [{ phase: "webrtc-handshake", durationMs: 812.4, success: true }, { phase: "publish-local-track", durationMs: 95, success: true }] } });

  const messages = bridge.logs.map(({ message }) => message);
  assert.equal(messages.filter((m) => m === "Waiting for a free slot on the service: position 2 of 3").length, 1, "each queue position once");
  assert.ok(messages.some((m) => /^Output audio track arrived after \d+\.\ds$/.test(m)));
  assert.ok(messages.some((m) => /^Output video track arrived after \d+\.\ds$/.test(m)));
  assert.ok(messages.some((m) => /^Connected in \d+\.\ds — token \d+\.\ds · connected \d+\.\ds · generating \d+\.\ds · video \d+\.\ds$/.test(m)), JSON.stringify(messages));
  assert.ok(messages.includes("Service connection steps: webrtc-handshake 812 ms · publish-local-track 95 ms"));
  session.hardStop();
});

test("the service's generation count is logged once per session, not again on later stops", async () => {
  installBrowserMocks();
  const { sdk, log } = fakeSdk();
  const bridge = fakeBridge();
  const session = newSession({ sdk, bridge });
  await session.connect();
  log.connects[0].realtime.emit("generationTick", { seconds: 5 });
  session.disconnect();
  session.hardStop();
  session.hardStop();
  assert.equal(bridge.logs.filter(({ message }) => message === "The service reported 5 s of generation for this session").length, 1);
});
