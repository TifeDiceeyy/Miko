// Opt-in: loads Miko's OBS pages in a real Chrome. Set MIKO_BROWSER to the
// Chrome executable. CI's Windows job runs it with the runner's Chrome, the
// same engine OBS's Browser Source embeds. Needs Node 22+ (global WebSocket).
const test = require("node:test");
const assert = require("node:assert/strict");
const { spawn } = require("node:child_process");
const fs = require("node:fs");
const http = require("node:http");
const os = require("node:os");
const path = require("node:path");
const { pathToFileURL } = require("node:url");
const zlib = require("node:zlib");
const { createObsRelay, loaderHtml } = require("../lib/obs-relay");

const browser = process.env.MIKO_BROWSER;
const skip = !browser
  ? "set MIKO_BROWSER to a Chrome executable to run"
  : typeof WebSocket !== "function" ? "needs Node 22+ (global WebSocket)" : false;
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const black = [0, 0, 0];
const red = [220, 30, 30];
const green = [30, 200, 60];
const blue = [40, 60, 230];

const crcTable = Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});
function crc32(buf) {
  let c = 0xffffffff;
  for (const byte of buf) c = crcTable[(c ^ byte) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}
function pngChunk(type, data) {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([length, body, crc]);
}
function solidPng(width, height, [r, g, b]) {
  const row = Buffer.alloc(1 + width * 3);
  for (let x = 0; x < width; x += 1) row.set([r, g, b], 1 + x * 3);
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header.set([8, 2, 0, 0, 0], 8);
  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    pngChunk("IHDR", header),
    pngChunk("IDAT", zlib.deflateSync(Buffer.concat(Array(height).fill(row)))),
    pngChunk("IEND", Buffer.alloc(0))
  ]);
}
// A 1×1 PNG's single scanline needs no unfiltering: with no neighbours,
// every PNG filter leaves the bytes as they are.
function onlyPixel(png) {
  const colorType = png[25];
  const chunks = [];
  for (let at = 8; at < png.length;) {
    const length = png.readUInt32BE(at);
    if (png.toString("latin1", at + 4, at + 8) === "IDAT") chunks.push(png.subarray(at + 8, at + 8 + length));
    at += 12 + length;
  }
  const raw = zlib.inflateSync(Buffer.concat(chunks));
  assert.ok(colorType === 2 || colorType === 6, `unexpected PNG colour type ${colorType}`);
  return [raw[1], raw[2], raw[3]];
}

async function until(get, label, ms = 10000) {
  const deadline = Date.now() + ms;
  let last;
  for (;;) {
    try { last = await get(); } catch (error) { last = error.message; }
    if (last && last.ok !== false) return last;
    if (Date.now() > deadline) throw new Error(`${label}: timed out (last: ${JSON.stringify(last)})`);
    await sleep(100);
  }
}

function freePort() {
  return new Promise((resolve) => {
    const server = http.createServer();
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address();
      server.close(() => resolve(port));
    });
  });
}

// Starts a headless Chrome with a throwaway profile at a square 1000×1000
// viewport, so a 16:9 frame shows bars above and below.
async function withChrome(run) {
  // Fail loudly rather than skip: CI must really run this on Windows.
  assert.ok(fs.existsSync(browser), `MIKO_BROWSER points at ${browser}, which doesn't exist on this machine`);
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), "miko-obs-page-"));
  const chrome = spawn(browser, [
    "--headless=new", "--remote-debugging-port=0", `--user-data-dir=${profile}`,
    "--no-first-run", "--no-default-browser-check", "--window-size=1000,1000", "about:blank"
  ], { stdio: "ignore" });
  let socket;
  try {
    const devtoolsPort = await until(() => {
      try { return fs.readFileSync(path.join(profile, "DevToolsActivePort"), "utf8").split("\n")[0].trim() || null; } catch { return null; }
    }, "Chrome's debugging port", 30000);
    const target = await until(async () => {
      const list = await (await fetch(`http://127.0.0.1:${devtoolsPort}/json`)).json();
      return list.find((entry) => entry.type === "page") || null;
    }, "Chrome's page target", 30000);

    socket = new WebSocket(target.webSocketDebuggerUrl);
    await new Promise((resolve, reject) => {
      socket.addEventListener("open", resolve, { once: true });
      socket.addEventListener("error", reject, { once: true });
    });
    let nextId = 0;
    const replies = new Map();
    socket.addEventListener("message", (event) => {
      const message = JSON.parse(event.data);
      if (replies.has(message.id)) {
        replies.get(message.id)(message);
        replies.delete(message.id);
      }
    });
    const send = (method, params = {}) => new Promise((resolve) => {
      const id = ++nextId;
      replies.set(id, resolve);
      socket.send(JSON.stringify({ id, method, params }));
    });
    const evaluate = async (expression) => (await send("Runtime.evaluate", { expression, returnByValue: true })).result.result.value;
    const pixel = async (x, y) => {
      const shot = await send("Page.captureScreenshot", { format: "png", clip: { x, y, width: 1, height: 1, scale: 1 } });
      return onlyPixel(Buffer.from(shot.result.data, "base64"));
    };
    const near = (actual, expected) => actual.every((value, i) => Math.abs(value - expected[i]) <= 3);
    const expectPixels = (label, points, ms = 10000) => until(async () => {
      const seen = [];
      for (const [x, y, colour] of points) {
        const actual = await pixel(x, y);
        seen.push({ x, y, actual, expected: colour });
        if (!near(actual, colour)) return { ok: false, seen };
      }
      return { ok: true, seen };
    }, label, ms);

    await send("Emulation.setDeviceMetricsOverride", { width: 1000, height: 1000, deviceScaleFactor: 1, mobile: false });
    await run({ navigate: (url) => send("Page.navigate", { url }), evaluate, expectPixels });
  } finally {
    socket?.close();
    chrome.kill();
    await sleep(1000);
    try { fs.rmSync(profile, { recursive: true, force: true }); } catch {}
  }
}

test("OBS URL page in a real browser: fits without cropping, goes black, reconnects, shows the newest frame", { skip, timeout: 90000 }, async () => {
  const relay = createObsRelay();
  const { port } = await relay.start(0);
  try {
    await withChrome(async (page) => {
      const pageState = () => page.evaluate("({ state: document.body.dataset.state, canvas: [document.getElementById('frame').width, document.getElementById('frame').height] })");

      // A 1280×720 frame in a square source: full width, black bars above and
      // below. Nothing cropped (the left and right edges are the frame).
      relay.pushFrame(solidPng(1280, 720, red));
      await page.navigate(`http://127.0.0.1:${port}/`);
      await until(async () => ((await pageState()).state === "live" ? true : null), "first frame");
      await page.expectPixels("landscape fits", [[500, 100, black], [500, 500, red], [500, 900, black], [2, 500, red], [997, 500, red]]);

      // Miko closes: the source goes black instead of keeping the last face.
      await relay.stop();
      await until(async () => ((await pageState()).state === "waiting" ? true : null), "stream end noticed");
      await page.expectPixels("black after the stream ends", [[500, 500, black]]);

      // Miko is back: the page reconnects by itself. A portrait frame gets bars
      // on the sides, top and bottom edges intact.
      await relay.start(port);
      relay.pushFrame(solidPng(720, 1280, green));
      await until(async () => ((await pageState()).canvas[0] === 720 ? true : null), "reconnect by itself", 15000);
      await page.expectPixels("portrait fits", [[100, 500, black], [500, 500, green], [900, 500, black], [500, 2, green], [500, 997, green]]);

      // A burst ends on the newest frame.
      for (let i = 0; i < 40; i += 1) relay.pushFrame(solidPng(1280, 720, i === 39 ? blue : [i * 5, 120, 120]));
      await page.expectPixels("newest frame after a burst", [[500, 500, blue]]);
    });
  } finally {
    await relay.stop();
  }
});

test("Miko's OBS page file (Local file source) connects by itself, whichever app starts first", { skip, timeout: 120000 }, async () => {
  // Miko's port listed second, as when the usual port is taken.
  const unused = await freePort();
  const mikoPort = await freePort();
  const file = path.join(os.tmpdir(), `miko-obs-output-${process.pid}.html`);
  fs.writeFileSync(file, loaderHtml([unused, mikoPort]));
  const relay = createObsRelay();
  try {
    await withChrome(async (page) => {
      // OBS opens the page file while Miko is closed: plain black, no error page.
      await page.navigate(pathToFileURL(file).href);
      await sleep(3000);
      assert.equal(await page.evaluate("document.body.dataset.state"), "searching");
      assert.equal(await page.evaluate("document.getElementById('miko').style.visibility"), "hidden");
      await page.expectPixels("black while Miko is closed", [[500, 500, black], [100, 100, black]]);

      // Miko starts: the page finds it and shows the output, fitted.
      await relay.start(mikoPort);
      relay.pushFrame(solidPng(1280, 720, red));
      await page.expectPixels("found Miko", [[500, 100, black], [500, 500, red], [2, 500, red]], 20000);
      assert.equal(await page.evaluate("document.body.dataset.state"), "attached");

      // Miko closes: black again.
      await relay.stop();
      await page.expectPixels("black after Miko closes", [[500, 500, black]], 10000);

      // Miko comes back later: found again with no refresh.
      await sleep(6000);
      await relay.start(mikoPort);
      relay.pushFrame(solidPng(1280, 720, green));
      await page.expectPixels("found Miko again", [[500, 500, green]], 25000);
    });
  } finally {
    await relay.stop();
    fs.rmSync(file, { force: true });
  }
});
