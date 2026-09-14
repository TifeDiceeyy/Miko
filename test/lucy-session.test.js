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
