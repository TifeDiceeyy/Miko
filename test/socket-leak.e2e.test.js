// Drives the REAL @fal-ai/client realtime state machine (not a mock) against a
// fake WebSocket, to prove a stopped or failed connect never leaves a socket
// open and never re-opens one in the background.
const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");
const fs = require("node:fs");
const esbuild = require("esbuild");

class FakeWebSocket {
  static CONNECTING = 0;
  static OPEN = 1;
  static CLOSING = 2;
  static CLOSED = 3;
  static instances = [];
  constructor(url) {
    this.url = String(url);
    this.readyState = 0;
    this.listeners = {};
    FakeWebSocket.instances.push(this);
  }
  addEventListener(type, listener) {
    (this.listeners[type] ||= []).push(listener);
  }
  send() {}
  close() {
    if (this.readyState >= 2) return;
    this.readyState = 3;
    const event = { code: 1000, reason: "" };
    (this.listeners.close || []).forEach((listener) => listener(event));
    if (this.onclose) this.onclose(event);
  }
}
// Must be installed before the session bundle loads, so the guard wraps it
// and the real SDK opens its sockets through the guard.
globalThis.WebSocket = FakeWebSocket;

class MockTrack {
  constructor() { this.kind = "video"; }
  stop() {}
  getSettings() { return { width: 768, height: 768 }; }
  async applyConstraints() {}
}
class MockStream {
  constructor() { this.track = new MockTrack(); }
  getTracks() { return [this.track]; }
  getVideoTracks() { return [this.track]; }
}

const reports = [];
let tokensMinted = 0;
global.RTCRtpSender = { getCapabilities: () => ({ codecs: [] }) };
Object.defineProperty(global, "navigator", {
  configurable: true,
  value: { mediaDevices: { getUserMedia: async () => new MockStream() } }
});
global.window = {
  addEventListener() {},
  deepLiveCam: {
    getToken: async () => `token-${++tokensMinted}`,
    logEvent: (_level, message) => reports.push(message),
    deleteRequestPayload: async () => ({ ok: true })
  }
};

const bundlePath = path.join(__dirname, `.miko-e2e-test-${process.pid}.cjs`);
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

const liveSockets = () => FakeWebSocket.instances.filter((socket) => socket.readyState < 2);
const tick = (ms = 20) => new Promise((resolve) => setTimeout(resolve, ms));

function newSession() {
  const session = new LucyRealtimeSession("decart/lucy-2-5/realtime");
  session.setConnectGuard(async () => {});
  return session;
}

test("Stop during the socket handshake leaves no socket open", async () => {
  FakeWebSocket.instances = [];
  reports.length = 0;
  const session = newSession();
  const connecting = session.connect();
  await tick();
  assert.equal(liveSockets().length, 1, "the SDK should have opened exactly one socket");
  assert.equal(liveSockets()[0].readyState, FakeWebSocket.CONNECTING);

  session.disconnect();
  assert.equal(liveSockets().length, 0);
  assert.ok(
    reports.some((message) => message.includes("still open after its connection ended")),
    "the guard, not the SDK, had to close the mid-handshake socket"
  );
  await connecting;
});

test("rapid Start/Stop/Start never has more than one socket open", async () => {
  FakeWebSocket.instances = [];
  const session = newSession();
  for (let round = 0; round < 3; round += 1) {
    const connecting = session.connect();
    await tick();
    assert.ok(liveSockets().length <= 1, `round ${round}: more than one socket open`);
    session.disconnect();
    await connecting;
    assert.equal(liveSockets().length, 0, `round ${round}: a socket survived Stop`);
  }
  const connecting = session.connect();
  await tick();
  assert.equal(liveSockets().length, 1);
  session.hardStop();
  await connecting;
  assert.equal(liveSockets().length, 0);
});

test("a closed connection is never re-opened by a late send", async () => {
  FakeWebSocket.instances = [];
  const session = newSession();
  const connecting = session.connect();
  await tick();
  const staleHandle = session.connection;
  session.disconnect();
  await connecting;

  const socketsBefore = FakeWebSocket.instances.length;
  const tokensBefore = tokensMinted;
  // This is what the SDK's delayed (throttled) send used to do after close.
  // A connection stopped mid-handshake keeps its token, so the SDK builds a
  // socket without asking for a new one; the guard must close it in its
  // constructor, before any network activity.
  staleHandle.send({ type: "icecandidate", candidate: { candidate: "late" } });
  await tick(50);
  const builtAfterStop = FakeWebSocket.instances.slice(socketsBefore);
  assert.ok(
    builtAfterStop.every((socket) => socket.readyState === FakeWebSocket.CLOSED),
    "any socket built for a stopped attempt is closed immediately"
  );
  assert.equal(tokensMinted, tokensBefore, "no token may be minted for a stopped attempt");
  assert.equal(liveSockets().length, 0);
});
