const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");
const fs = require("node:fs");
const esbuild = require("esbuild");
const { fal } = require("@fal-ai/client");

const bundlePath = path.join(__dirname, `.miko-session-test-${process.pid}.cjs`);
esbuild.buildSync({
  entryPoints: [path.join(__dirname, "../lib/lucy-realtime-session.ts")],
  bundle: true,
  platform: "node",
  format: "cjs",
  external: ["@fal-ai/client"],
  outfile: bundlePath
});
const { LucyRealtimeSession } = require(bundlePath);
test.after(() => fs.rmSync(bundlePath, { force: true }));

class MockTrack {
  constructor() { this.kind = "video"; this.stopped = false; this.constraints = []; }
  stop() { this.stopped = true; }
  getSettings() { return { width: 768, height: 768 }; }
  async applyConstraints(value) { this.constraints.push(value); }
}

class MockStream {
  constructor() { this.track = new MockTrack(); }
  getTracks() { return [this.track]; }
  getVideoTracks() { return [this.track]; }
}

class MockPeerConnection {
  static latest = null;
  constructor(configuration) {
    this.configuration = configuration;
    this.connectionState = "new";
    this.iceConnectionState = "new";
    this.signalingState = "stable";
    this.localDescription = null;
    this.remoteDescription = null;
    this.closed = false;
    this.statsQueue = [];
    this.sender = {
      track: new MockTrack(),
      getParameters: () => ({ encodings: [{}] }),
      setParameters: async () => {},
      replaceTrack: async () => {}
    };
    MockPeerConnection.latest = this;
  }
  addTrack(track) { this.sender.track = track; return this.sender; }
  getTransceivers() { return [{ sender: this.sender, setCodecPreferences() {} }]; }
  getSenders() { return [this.sender]; }
  async createOffer() { return { type: "offer", sdp: "mock-offer" }; }
  async setLocalDescription(description) {
    this.localDescription = description;
    this.signalingState = "have-local-offer";
  }
  async setRemoteDescription(description) {
    this.remoteDescription = description;
    this.signalingState = "stable";
  }
  async addIceCandidate() {}
  async getStats() { return this.statsQueue.shift() || new Map(); }
  close() { this.closed = true; this.connectionState = "closed"; }
}

function installBrowserMocks() {
  global.RTCPeerConnection = MockPeerConnection;
  global.RTCRtpSender = { getCapabilities: () => ({ codecs: [] }) };
  Object.defineProperty(global, "navigator", {
    configurable: true,
    value: { mediaDevices: { getUserMedia: async () => new MockStream() } }
  });
  global.window = {
    addEventListener() {},
    deepLiveCam: {
      getToken: async () => "mock-token",
      deleteRequestPayload: async () => ({ ok: true })
    }
  };
}

function installFalMock() {
  const originalConnect = fal.realtime.connect;
  let connectCalls = 0;
  let closed = false;
  let options;
  let endpoint;
  const sent = [];
  fal.realtime.connect = (suppliedEndpoint, suppliedOptions) => {
    connectCalls += 1;
    endpoint = suppliedEndpoint;
    options = suppliedOptions;
    queueMicrotask(async () => {
      await options.tokenProvider("decart/lucy-2-5/realtime");
      await options.onResult({ type: "iceServers", iceServers: [{ urls: "stun:mock.invalid" }], request_id: "12345678-abcd" });
    });
    return {
      send(message) {
        sent.push(message);
        if (message.type !== "offer") return;
        queueMicrotask(async () => {
          await options.onResult({ type: "answer", sdp: "mock-answer" });
          MockPeerConnection.latest.ontrack({ streams: [new MockStream()] });
        });
      },
      close() { closed = true; }
    };
  };
  return {
    get connectCalls() { return connectCalls; },
    get closed() { return closed; },
    get options() { return options; },
    get endpoint() { return endpoint; },
    get sent() { return sent; },
    restore() { fal.realtime.connect = originalConnect; }
  };
}

test("runs one shared gate before opening mocked signaling and WebRTC", async () => {
  installBrowserMocks();
  const realtime = installFalMock();
  const session = new LucyRealtimeSession("decart/lucy-2-5/realtime");
  let gateCalls = 0;
  session.setConnectGuard(async () => { gateCalls += 1; });

  await session.connect();
  assert.equal(gateCalls, 1);
  assert.equal(realtime.connectCalls, 1);
  assert.equal(Object.hasOwn(realtime.options, "connectionKey"), false);
  assert.equal(session.getSnapshot().state, "live");
  assert.equal(MockPeerConnection.latest.configuration.iceServers[0].urls, "stun:mock.invalid");

  session.hardStop();
  assert.equal(realtime.closed, true);
  assert.equal(MockPeerConnection.latest.closed, true);
  realtime.restore();
});

test("every connect logs how long each step took", async () => {
  installBrowserMocks();
  const logs = [];
  window.deepLiveCam.logEvent = (level, message) => logs.push({ level, message });
  const realtime = installFalMock();
  const session = new LucyRealtimeSession("decart/lucy-2-5/realtime");
  session.setConnectGuard(async () => {});

  await session.connect();
  const line = logs.find(({ message }) => message.startsWith("Connected in"));
  assert.ok(line, JSON.stringify(logs));
  assert.equal(line.level, "info");
  assert.match(line.message, /^Connected in \d+\.\ds — token \d+\.\ds · service ready \d+\.\ds · offer sent \d+\.\ds · answer \d+\.\ds · video \d+\.\ds$/);

  session.hardStop();
  realtime.restore();
});

test("a rejected gate prevents any billable signaling connection", async () => {
  installBrowserMocks();
  const realtime = installFalMock();
  const session = new LucyRealtimeSession("decart/lucy-2-5/realtime");
  session.setConnectGuard(async () => { throw new Error("Balance is at or below the $1.00 safety floor."); });

  await session.connect();
  assert.equal(realtime.connectCalls, 0);
  assert.equal(session.getSnapshot().state, "error");
  realtime.restore();
});

test("a transient token refresh failure does not kill a healthy call", async () => {
  installBrowserMocks();
  const realtime = installFalMock();
  const session = new LucyRealtimeSession("decart/lucy-2-5/realtime");
  session.setConnectGuard(async () => {});
  await session.connect();

  window.deepLiveCam.getToken = async () => { throw new Error("temporary network outage"); };
  await assert.rejects(() => realtime.options.tokenProvider("decart/lucy-2-5/realtime"));
  assert.equal(session.getSnapshot().state, "live");
  assert.equal(realtime.closed, false);

  session.hardStop();
  realtime.restore();
});

test("an exhausted account during token refresh ends the call without reconnecting", async () => {
  installBrowserMocks();
  const realtime = installFalMock();
  const session = new LucyRealtimeSession("decart/lucy-2-5/realtime");
  session.setConnectGuard(async () => {});
  await session.connect();

  window.deepLiveCam.getToken = async () => { throw new Error("Account balance is exhausted"); };
  await assert.rejects(() => realtime.options.tokenProvider("decart/lucy-2-5/realtime"));
  assert.equal(session.getSnapshot().state, "error");
  assert.equal(realtime.closed, true);
  realtime.restore();
});

test("network loss uses interval deltas and poor quality never reconnects", async () => {
  installBrowserMocks();
  const realtime = installFalMock();
  const session = new LucyRealtimeSession("decart/lucy-2-5/realtime");
  session.setConnectGuard(async () => {});
  await session.connect();
  const pc = MockPeerConnection.latest;
  const sample = (sent, lost) => new Map([
    ["out", { type: "outbound-rtp", kind: "video", packetsSent: sent }],
    ["remote", { type: "remote-inbound-rtp", packetsLost: lost, roundTripTime: 0.05 }]
  ]);
  pc.statsQueue.push(sample(100, 5), sample(200, 5), sample(300, 15));

  await session.pollStats();
  await session.pollStats();
  assert.equal(session.getSnapshot().networkQuality, "good");
  await session.pollStats();
  assert.equal(session.getSnapshot().networkQuality, "poor");
  assert.equal(realtime.connectCalls, 1);
  assert.equal(session.getSnapshot().localStream.getVideoTracks()[0].constraints.length, 1);

  session.hardStop();
  realtime.restore();
});

test("Lite receives the full character-swap prompt and reference unchanged", async () => {
  installBrowserMocks();
  const realtime = installFalMock();
  const presets = require("../lib/session-presets");
  const session = new LucyRealtimeSession(presets.MODELS.lite);
  session.setConnectGuard(async () => {});
  session.updateEditParams({ prompt: presets.DEFAULT_PROMPTS.character, referenceImageUrl: "data:image/jpeg;base64,AAAA" });

  await session.connect();
  assert.equal(realtime.endpoint, "decart/lucy2-vton/realtime");
  const firstMessage = realtime.sent[0];
  assert.equal(firstMessage.prompt, presets.DEFAULT_PROMPTS.character);
  assert.equal(firstMessage.reference_image_url, "data:image/jpeg;base64,AAAA");
  assert.equal(session.getSnapshot().state, "live");

  session.hardStop();
  realtime.restore();
});

test("connects with no send throttling and no background token refresh", async () => {
  installBrowserMocks();
  const realtime = installFalMock();
  const session = new LucyRealtimeSession("decart/lucy-2-5/realtime");
  session.setConnectGuard(async () => {});
  await session.connect();
  assert.equal(realtime.options.throttleInterval, 0);
  assert.equal(Object.hasOwn(realtime.options, "tokenExpirationSeconds"), false);
  session.hardStop();
  realtime.restore();
});

const settleWithin = (promise, ms = 50) => Promise.race([
  promise.then(() => "resolved", () => "rejected"),
  new Promise((resolve) => setTimeout(() => resolve("pending"), ms))
]);

test("an abandoned attempt never receives a token", async () => {
  installBrowserMocks();
  const realtime = installFalMock();
  let tokenRequests = 0;
  window.deepLiveCam.getToken = async () => { tokenRequests += 1; return "mock-token"; };
  const session = new LucyRealtimeSession("decart/lucy-2-5/realtime");
  session.setConnectGuard(async () => {});
  await session.connect();
  const tokenProvider = realtime.options.tokenProvider;
  session.disconnect();

  const requestsBefore = tokenRequests;
  assert.equal(await settleWithin(tokenProvider("decart/lucy-2-5/realtime")), "pending");
  assert.equal(tokenRequests, requestsBefore);
  realtime.restore();
});

test("Stop during the token request never hands the late token to the SDK", async () => {
  installBrowserMocks();
  let releaseToken;
  window.deepLiveCam.getToken = () => new Promise((resolve) => { releaseToken = () => resolve("late-token"); });
  const originalConnect = fal.realtime.connect;
  let options;
  fal.realtime.connect = (_endpoint, suppliedOptions) => {
    options = suppliedOptions;
    return { send() {}, close() {} };
  };
  const session = new LucyRealtimeSession("decart/lucy-2-5/realtime");
  session.setConnectGuard(async () => {});
  const connecting = session.connect();
  await new Promise((resolve) => setTimeout(resolve, 0));

  const pendingToken = options.tokenProvider("decart/lucy-2-5/realtime");
  session.disconnect();
  releaseToken();
  assert.equal(await settleWithin(pendingToken), "pending");
  await connecting;
  fal.realtime.connect = originalConnect;
});

test("a WebRTC connect timeout hard-stops after one attempt, with no VPN verdict and no auto-retry", async (t) => {
  installBrowserMocks();
  const logs = [];
  window.deepLiveCam.logEvent = (level, message) => logs.push({ level, message });
  const originalConnect = fal.realtime.connect;
  let connectCalls = 0;
  let closed = false;
  fal.realtime.connect = (_endpoint, options) => {
    connectCalls += 1;
    // Never resolves iceServers/error — forces the real WEBRTC_CONNECT_TIMEOUT_MS
    // giving-up timer to fire, exactly like fal's server going silent.
    return { send() {}, close: () => { closed = true; } };
  };
  const session = new LucyRealtimeSession("decart/lucy-2-5/realtime");
  session.setConnectGuard(async () => {});

  // Mocked setTimeout, so the 10 s limit passes without a real 10 s wait.
  t.mock.timers.enable({ apis: ["setTimeout"] });
  let settled = false;
  const connecting = session.connect().then(() => { settled = true; });
  for (let i = 0; i < 100 && !settled; i += 1) {
    await new Promise((resolve) => setImmediate(resolve));
    t.mock.timers.tick(1000);
  }
  await connecting;
  t.mock.timers.reset();
  assert.equal(session.getSnapshot().state, "error", "a single timeout is terminal, not retried");
  assert.match(session.getSnapshot().error, /didn't arrive within 10s/);
  assert.ok(
    logs.some(({ level, message }) => level === "warn" && /^Connect failed after \d+\.\ds — no step reached · waiting on: token \(timed out waiting for WebRTC connection\)$/.test(message)),
    JSON.stringify(logs)
  );
  // The synthetic timeout has no evidence of a local network/VPN problem —
  // it must not claim one.
  assert.doesNotMatch(session.getSnapshot().error, /VPN, proxy or firewall/);
  assert.match(session.getSnapshot().error, /didn't arrive within/);
  assert.ok(closed, "the half-open signaling connection is hard-stopped, not left lingering");

  await new Promise((resolve) => setTimeout(resolve, 500));
  assert.equal(connectCalls, 1, "no automatic reconnect ever happens");

  session.hardStop();
  fal.realtime.connect = originalConnect;
});

test("a concurrent-session-limit error hard-stops immediately with its own accurate message, not a VPN guess", async () => {
  installBrowserMocks();
  const originalConnect = fal.realtime.connect;
  let connectCalls = 0;
  fal.realtime.connect = (_endpoint, options) => {
    connectCalls += 1;
    queueMicrotask(() => options.onResult({ type: "error", error: "Concurrent session limit reached." }));
    return { send() {}, close() {} };
  };
  const session = new LucyRealtimeSession("decart/lucy-2-5/realtime");
  session.setConnectGuard(async () => {});

  await session.connect();
  assert.equal(session.getSnapshot().state, "error");
  assert.match(session.getSnapshot().error, /Too many active sessions/);
  assert.doesNotMatch(session.getSnapshot().error, /VPN, proxy or firewall/);
  assert.doesNotMatch(session.getSnapshot().error, /retrying automatically/, "no retry is actually attempted, so the message must not claim one");

  await new Promise((resolve) => setTimeout(resolve, 500));
  assert.equal(connectCalls, 1, "no automatic reconnect ever happens");

  session.hardStop();
  fal.realtime.connect = originalConnect;
});

test("an ICE connection failure after negotiating names a firewall/VPN specifically — a real observed signal, unlike a blind timeout", async () => {
  installBrowserMocks();
  const realtime = installFalMock();
  const session = new LucyRealtimeSession("decart/lucy-2-5/realtime");
  session.setConnectGuard(async () => {});
  await session.connect();
  assert.equal(session.getSnapshot().state, "live");

  const pc = MockPeerConnection.latest;
  pc.iceConnectionState = "failed";
  pc.oniceconnectionstatechange?.();

  assert.equal(session.getSnapshot().state, "error");
  assert.match(session.getSnapshot().error, /firewall, VPN, or restrictive network/);
  assert.equal(realtime.connectCalls, 1, "no automatic reconnect ever happens");

  session.hardStop();
  realtime.restore();
});
