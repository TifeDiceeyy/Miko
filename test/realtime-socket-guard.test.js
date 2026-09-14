const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");
const fs = require("node:fs");
const esbuild = require("esbuild");

const bundlePath = path.join(__dirname, `.miko-guard-test-${process.pid}.cjs`);
esbuild.buildSync({
  entryPoints: [path.join(__dirname, "../lib/realtime-socket-guard.ts")],
  bundle: true,
  platform: "node",
  format: "cjs",
  outfile: bundlePath
});
const { createRealtimeSocketGuard } = require(bundlePath);
test.after(() => fs.rmSync(bundlePath, { force: true }));

class FakeWebSocket {
  static CONNECTING = 0;
  static OPEN = 1;
  static CLOSING = 2;
  static CLOSED = 3;
  constructor(url) {
    this.url = String(url);
    this.readyState = 0;
    this.closeListeners = [];
  }
  addEventListener(type, listener) {
    if (type === "close") this.closeListeners.push(listener);
  }
  close() {
    if (this.readyState >= 2) return;
    this.readyState = 3;
    this.closeListeners.forEach((listener) => listener());
  }
}

const realtimeUrl = (token) => `wss://fal.run/decart/lucy-2-5/realtime?fal_jwt_token=${token}`;

function setup() {
  const reports = [];
  const { guard, GuardedWebSocket } = createRealtimeSocketGuard(FakeWebSocket, (message) => reports.push(message));
  return { guard, WS: GuardedWebSocket, reports };
}

test("keeps the socket that belongs to the current attempt", () => {
  const { guard, WS, reports } = setup();
  const ticket = guard.beginAttempt();
  guard.claimToken("t1", ticket);
  const socket = new WS(realtimeUrl("t1"));
  assert.equal(socket.readyState, 0);
  assert.equal(guard.liveSocketCount(), 1);
  assert.equal(reports.length, 0);
});

test("ending an attempt closes its socket even mid-handshake", () => {
  const { guard, WS, reports } = setup();
  const ticket = guard.beginAttempt();
  guard.claimToken("t1", ticket);
  const socket = new WS(realtimeUrl("t1"));
  guard.endAttempt(ticket);
  assert.equal(socket.readyState, 3);
  assert.equal(guard.liveSocketCount(), 0);
  assert.equal(reports.length, 1);
});

test("a socket opened with a token from an ended attempt closes immediately", () => {
  const { guard, WS } = setup();
  const ticket = guard.beginAttempt();
  guard.claimToken("t1", ticket);
  guard.endAttempt(ticket);
  const late = new WS(realtimeUrl("t1"));
  assert.equal(late.readyState, 3);
});

test("a token claimed for an inactive attempt is refused", () => {
  const { guard, WS } = setup();
  const first = guard.beginAttempt();
  guard.beginAttempt();
  guard.claimToken("stale", first);
  const socket = new WS(realtimeUrl("stale"));
  assert.equal(socket.readyState, 3);
});

test("starting a new attempt closes leftovers, so at most one socket is live", () => {
  const { guard, WS } = setup();
  const first = guard.beginAttempt();
  guard.claimToken("a", first);
  const a = new WS(realtimeUrl("a"));
  const second = guard.beginAttempt();
  assert.equal(a.readyState, 3);
  guard.claimToken("b", second);
  const b = new WS(realtimeUrl("b"));
  assert.equal(b.readyState, 0);
  assert.equal(guard.liveSocketCount(), 1);
});

test("leaves non-realtime sockets alone", () => {
  const { guard, WS } = setup();
  guard.beginAttempt();
  const other = new WS("wss://example.com/socket");
  assert.equal(other.readyState, 0);
  assert.equal(guard.liveSocketCount(), 0);
});
