const test = require("node:test");
const assert = require("node:assert/strict");
const http = require("node:http");
const net = require("node:net");
const { createObsRelay, createPartParser, loaderHtml, PAGE_SCRIPT } = require("../lib/obs-relay");

async function until(condition, ms = 3000) {
  const deadline = Date.now() + ms;
  while (!condition()) {
    if (Date.now() > deadline) throw new Error("timed out waiting");
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

function get(port, path, headers = {}) {
  return new Promise((resolve, reject) => {
    const req = http.get({ host: "127.0.0.1", port, path, headers }, (res) => {
      const chunks = [];
      res.on("data", (chunk) => chunks.push(chunk));
      res.on("end", () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks).toString() }));
    });
    req.on("error", reject);
  });
}

// Reads the frame stream the way the OBS page does.
function watch(port) {
  const viewer = { frames: [], ended: false };
  const req = http.get({ host: "127.0.0.1", port, path: "/stream" }, (res) => {
    const push = createPartParser((bytes) => viewer.frames.push(Buffer.from(bytes)), 1e8);
    res.on("data", (chunk) => push(new Uint8Array(chunk)));
    res.on("end", () => { viewer.ended = true; });
    res.on("error", () => { viewer.ended = true; });
  });
  req.on("error", () => { viewer.ended = true; });
  viewer.close = () => req.destroy();
  return viewer;
}

test("the page's parser rebuilds frames however the stream is split", () => {
  const frames = [Buffer.alloc(5000, 1), Buffer.from("small"), Buffer.alloc(70000, 7)];
  const stream = Buffer.concat([
    Buffer.from("HTTP/1.0 200 OK\r\nContent-Type: multipart/x-mixed-replace; boundary=frame\r\n\r\n"),
    ...frames.flatMap((frame) => [
      Buffer.from(`--frame\r\nContent-Type: image/png\r\nContent-Length: ${frame.length}\r\n\r\n`),
      frame,
      Buffer.from("\r\n")
    ])
  ]);
  for (const chunkSize of [1, 7, 4096, stream.length]) {
    const got = [];
    const push = createPartParser((bytes, type) => got.push({ bytes: Buffer.from(bytes), type }), 1e8);
    for (let i = 0; i < stream.length; i += chunkSize) push(new Uint8Array(stream.subarray(i, i + chunkSize)));
    assert.equal(got.length, frames.length, `chunk size ${chunkSize}`);
    got.forEach(({ bytes, type }, i) => {
      assert.ok(bytes.equals(frames[i]), `frame ${i}, chunk size ${chunkSize}`);
      assert.equal(type, "image/png");
    });
  }
});

test("the OBS page fits the frame without cropping and runs its script under a strict CSP", async () => {
  const relay = createObsRelay();
  const { port } = await relay.start(0);
  try {
    const page = await get(port, "/");
    assert.equal(page.status, 200);
    assert.match(page.body, /<canvas id="frame">/);
    assert.match(page.body, /object-fit:contain/);
    assert.match(page.body, /script-src 'self'/);
    assert.match(page.body, /style-src 'unsafe-inline'/);
    assert.doesNotMatch(page.body, /unsafe-eval|script-src[^;"]*unsafe-inline/);

    const script = await get(port, "/page.js");
    assert.equal(script.status, 200);
    assert.match(script.headers["content-type"], /javascript/);
    assert.equal(script.body, PAGE_SCRIPT);
    assert.doesNotThrow(() => new Function(PAGE_SCRIPT), "the page script compiles");
    assert.match(PAGE_SCRIPT, /setTimeout\(connect, 1000\)/, "the page reconnects by itself");

    assert.equal((await get(port, "/", { Host: "evil.example" })).status, 403);
    assert.equal((await get(port, "/missing")).status, 404);
  } finally {
    await relay.stop();
  }
});

test("the stream answers straight away, before any frame exists", async () => {
  const relay = createObsRelay();
  const { port } = await relay.start(0);
  try {
    const status = await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("no response headers without a frame")), 1000);
      const req = http.get({ host: "127.0.0.1", port, path: "/stream" }, (res) => {
        clearTimeout(timer);
        resolve(res.statusCode);
        req.destroy();
      });
      req.on("error", () => {});
    });
    assert.equal(status, 200);
  } finally {
    await relay.stop();
  }
});

test("a viewer gets the latest frame, then each new one; a cleared frame is never replayed", async () => {
  const relay = createObsRelay();
  const { port } = await relay.start(0);
  try {
    relay.pushFrame(Buffer.from("frame-a"));
    const viewer = watch(port);
    await until(() => viewer.frames.length === 1);
    relay.pushFrame(Buffer.from("frame-b"));
    await until(() => viewer.frames.length === 2);
    assert.deepEqual(viewer.frames.map(String), ["frame-a", "frame-b"]);

    relay.clearFrame();
    const late = watch(port);
    await until(() => relay.clientCount === 2);
    await new Promise((resolve) => setTimeout(resolve, 150));
    assert.equal(late.frames.length, 0, "a viewer arriving after the call sees no old face");
    viewer.close();
    late.close();
  } finally {
    await relay.stop();
  }
});

test("stopping ends every viewer's stream, and the relay starts again on the same port", async () => {
  const relay = createObsRelay();
  relay.pushFrame(Buffer.from("ignored while stopped"));
  const { port } = await relay.start(0);
  const viewer = watch(port);
  await until(() => relay.clientCount === 1);
  await relay.stop();
  await until(() => viewer.ended);
  assert.equal(relay.running, false);

  assert.deepEqual(await relay.start(port), { port });
  assert.deepEqual(await relay.start(port), { port }, "starting twice is harmless");
  relay.pushFrame(Buffer.from("after-restart"));
  const again = watch(port);
  await until(() => again.frames.length === 1);
  assert.equal(String(again.frames[0]), "after-restart");
  again.close();
  await relay.stop();
});

// Holds a port the way another program would; fine if it's already held.
function occupy(port) {
  return new Promise((resolve) => {
    const server = http.createServer();
    server.once("error", () => resolve(null));
    server.listen(port, "127.0.0.1", () => resolve(server));
  });
}

test("if the usual port is taken, the relay moves to the next free one, and says so when none is left", async () => {
  const first = await occupy(0);
  const taken = first.address().port;
  const relay = createObsRelay();
  const { port } = await relay.startPreferred(taken, 3);
  assert.ok(port > taken && port <= taken + 3, `moved from ${taken} to ${port}`);
  await relay.stop();

  const second = await occupy(taken + 1);
  const other = createObsRelay();
  await assert.rejects(other.startPreferred(taken, 1), (error) => {
    assert.equal(error.code, "ENOPORT");
    assert.equal(error.failures.length, 2);
    return true;
  });
  first.close();
  second?.close();
});

test("a viewer that stops reading holds at most one frame and still ends on the newest one", async () => {
  const relay = createObsRelay();
  const { port } = await relay.start(0);
  const socket = net.connect(port, "127.0.0.1");
  await new Promise((resolve) => socket.once("connect", resolve));
  socket.write(`GET /stream HTTP/1.0\r\nHost: 127.0.0.1:${port}\r\n\r\n`);
  await until(() => relay.clientCount === 1);
  socket.pause();

  const frameBytes = 1024 * 1024;
  for (let i = 0; i < 40; i += 1) {
    relay.pushFrame(Buffer.alloc(frameBytes, i));
    await new Promise((resolve) => setTimeout(resolve, 5));
    assert.ok(relay.bufferedBytes() < 2 * frameBytes, `${relay.bufferedBytes()} bytes queued after frame ${i}`);
  }
  const endOfCall = Buffer.alloc(frameBytes, 0xee);
  relay.pushFrame(endOfCall);
  relay.clearFrame();

  const received = [];
  const push = createPartParser((bytes) => received.push(Buffer.from(bytes)), 1e8);
  socket.on("data", (chunk) => push(new Uint8Array(chunk)));
  socket.resume();
  await until(() => received.length > 0 && received[received.length - 1].equals(endOfCall), 5000);
  assert.ok(received.length < 41, `${received.length} of 41 frames sent; the rest were skipped, not queued`);
  socket.destroy();
  await relay.stop();
});

test("the output page reports in to Miko's OBS page file, which looks for Miko on all its ports", () => {
  assert.match(PAGE_SCRIPT, /postMessage\(\{ miko: "obs-alive"/);
  const html = loaderHtml([7893, 7894, 7895]);
  assert.match(html, /\(\[7893,7894,7895\]\);<\/script>/);
  const script = html.slice(html.indexOf("<script>") + "<script>".length, html.lastIndexOf("</script>"));
  assert.doesNotThrow(() => new Function(script), "the page file's script compiles");
  assert.match(loaderHtml(), /\[7893,7894,7895,7896,7897,7898,7899,7900,7901,7902\]/);
});

test("the relay reports OBS connecting and leaving", async () => {
  const counts = [];
  const relay = createObsRelay({ onViewersChanged: (count) => counts.push(count) });
  const { port } = await relay.start(0);
  const viewer = watch(port);
  await until(() => counts.length === 1);
  viewer.close();
  await until(() => counts.length === 2);
  assert.deepEqual(counts, [1, 0]);
  const second = watch(port);
  await until(() => counts.length === 3);
  await relay.stop();
  assert.deepEqual(counts, [1, 0, 1, 0]);
  second.close();
});
