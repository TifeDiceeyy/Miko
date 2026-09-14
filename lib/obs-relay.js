// Local OBS output (main process only). Serves the page OBS's built-in
// Browser Source loads (/), its script (/page.js) and the frame stream the
// page reads (/stream). The page fits each frame inside whatever size the
// source is (black bars, never cropped or stretched), draws only the newest
// frame, goes black when the stream ends and reconnects by itself, so a
// Miko restart never leaves OBS frozen or blank.
const http = require("node:http");

const DEFAULT_PORT = 7893;
// How many ports after DEFAULT_PORT to try when it's taken or reserved.
const SPARE_PORTS = 9;
// A corrupt length must not make the page buffer forever; real PNG frames
// are a few MB at most.
const MAX_PART_BYTES = 64 * 1024 * 1024;

// Splits the multipart stream back into frames. Runs in the OBS page (it is
// shipped as source text in PAGE_SCRIPT) and in the tests, so it must not
// use anything outside its own body.
function createPartParser(onPart, maxPartBytes) {
  let buffer = new Uint8Array(1024 * 1024);
  let start = 0;
  let end = 0;
  const decoder = new TextDecoder();

  function append(chunk) {
    if (end + chunk.length > buffer.length) {
      const kept = end - start;
      let size = buffer.length;
      while (kept + chunk.length > size) size *= 2;
      if (size === buffer.length) {
        buffer.copyWithin(0, start, end);
      } else {
        const grown = new Uint8Array(size);
        grown.set(buffer.subarray(start, end));
        buffer = grown;
      }
      start = 0;
      end = kept;
    }
    buffer.set(chunk, end);
    end += chunk.length;
  }

  function headerEnd() {
    for (let i = start; i + 3 < end; i += 1) {
      if (buffer[i] === 13 && buffer[i + 1] === 10 && buffer[i + 2] === 13 && buffer[i + 3] === 10) return i;
    }
    return -1;
  }

  return function push(chunk) {
    append(chunk);
    for (;;) {
      const stop = headerEnd();
      if (stop < 0) return;
      const header = decoder.decode(buffer.subarray(start, stop));
      const length = /content-length:\s*(\d+)/i.exec(header);
      const type = /content-type:\s*([^\r\n;]+)/i.exec(header);
      const bodyStart = stop + 4;
      // Anything without a usable length (such as HTTP response headers
      // read off a raw socket) is skipped.
      if (!length || Number(length[1]) > maxPartBytes) {
        start = bodyStart;
        continue;
      }
      const bodyEnd = bodyStart + Number(length[1]);
      if (bodyEnd > end) return;
      onPart(buffer.slice(bodyStart, bodyEnd), type ? type[1].trim() : "image/png");
      start = bodyEnd;
      if (start === end) {
        start = 0;
        end = 0;
      }
    }
  };
}

// The OBS page's script, also shipped as source text.
function pageMain(createPartParser, maxPartBytes) {
  const canvas = document.getElementById("frame");
  const context = canvas.getContext("2d");
  let generation = 0;
  let newest = null;
  let drawing = false;

  function blank() {
    context.fillStyle = "#000";
    context.fillRect(0, 0, canvas.width, canvas.height);
  }

  // Decodes only the newest frame; frames that arrive meanwhile replace it.
  async function drawNewest() {
    if (drawing) return;
    drawing = true;
    while (newest) {
      const frame = newest;
      newest = null;
      try {
        const bitmap = await createImageBitmap(new Blob([frame.bytes], { type: frame.type }));
        if (frame.generation === generation) {
          if (canvas.width !== bitmap.width || canvas.height !== bitmap.height) {
            canvas.width = bitmap.width;
            canvas.height = bitmap.height;
          }
          context.drawImage(bitmap, 0, 0);
          document.body.dataset.state = "live";
        }
        bitmap.close();
      } catch (error) {
        // An undecodable frame is skipped; the next one replaces it.
      }
    }
    drawing = false;
  }

  async function connect() {
    const current = ++generation;
    try {
      const response = await fetch("/stream", { cache: "no-store" });
      if (!response.ok || !response.body) throw new Error(`stream answered ${response.status}`);
      document.body.dataset.state = "connected";
      const reader = response.body.getReader();
      const push = createPartParser((bytes, type) => {
        newest = { bytes, type, generation: current };
        drawNewest();
      }, maxPartBytes);
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        push(value);
      }
    } catch (error) {
      // Miko is closed or OBS output is off; try again below.
    }
    // The stream ended: go black rather than keep the last face on screen.
    generation += 1;
    newest = null;
    blank();
    document.body.dataset.state = "waiting";
    setTimeout(connect, 1000);
  }

  // Tells Miko's OBS page file (see loaderMain) that this page is alive and
  // whether its stream is up.
  function heartbeat() {
    if (window.parent !== window) window.parent.postMessage({ miko: "obs-alive", state: document.body.dataset.state }, "*");
  }

  blank();
  connect();
  heartbeat();
  setInterval(heartbeat, 1000);
}

const PAGE_SCRIPT = `"use strict";\n(${pageMain.toString()})(${createPartParser.toString()}, ${MAX_PART_BYTES});\n`;

// style-src must allow 'unsafe-inline', or the browser silently drops the
// whole <style> block (CSP falls back to default-src 'none' for any directive
// not set) and the frame renders at its bare size in the top-left corner.
// The script is a separate file so scripts stay limited to 'self'.
const PAGE_HTML = "<!doctype html><html><head><meta charset=\"utf-8\"><title>Miko output</title>" +
  "<meta http-equiv=\"Content-Security-Policy\" content=\"default-src 'none'; script-src 'self'; connect-src 'self'; style-src 'unsafe-inline'\">" +
  "<style>html,body{margin:0;height:100%;background:#000;overflow:hidden}canvas{display:block;width:100vw;height:100vh;object-fit:contain}</style>" +
  "</head><body data-state=\"waiting\"><canvas id=\"frame\"></canvas><script src=\"/page.js\"></script></body></html>";

// The page file Miko writes to its settings folder (obs-output.html) for
// OBS's Browser Source in "Local file" mode. A local file always loads, even
// while Miko is closed, so OBS never has to be refreshed: it points an iframe
// at Miko's output page, shows black until that page reports in, and goes
// back to searching when it stops. Shipped as source text.
function loaderMain(ports) {
  const frame = document.getElementById("miko");
  let attempt = 0;
  let attachedPort = null;
  let lastBeat = 0;
  let waitingSince = 0;
  let giveUpTimer = null;

  // The usual port every other try, the spare ports in between.
  function portFor(n) {
    if (ports.length === 1 || n % 2 === 0) return ports[0];
    const spares = ports.slice(1);
    return spares[Math.floor(n / 2) % spares.length];
  }

  function search() {
    attachedPort = null;
    waitingSince = 0;
    frame.style.visibility = "hidden";
    document.body.dataset.state = "searching";
    const port = portFor(attempt);
    attempt += 1;
    frame.dataset.port = String(port);
    frame.src = `http://127.0.0.1:${port}/?t=${Date.now()}`;
    clearTimeout(giveUpTimer);
    giveUpTimer = setTimeout(() => {
      if (attachedPort === null) search();
    }, 2000);
  }

  window.addEventListener("message", (event) => {
    if (!event.data || event.data.miko !== "obs-alive" || event.source !== frame.contentWindow) return;
    const port = Number(frame.dataset.port);
    if (event.origin !== `http://127.0.0.1:${port}`) return;
    lastBeat = Date.now();
    if (attachedPort === null) {
      attachedPort = port;
      attempt = 0;
      clearTimeout(giveUpTimer);
      frame.style.visibility = "visible";
      document.body.dataset.state = "attached";
    }
    if (event.data.state === "waiting") waitingSince = waitingSince || Date.now();
    else waitingSince = 0;
  });

  // Attached but silent (the page died), or its stream has been down for a
  // while (Miko closed, or came back on another port): search again.
  setInterval(() => {
    if (attachedPort === null) return;
    if (Date.now() - lastBeat > 3000 || (waitingSince && Date.now() - waitingSince > 5000)) search();
  }, 1000);

  search();
}

function loaderHtml(ports = Array.from({ length: SPARE_PORTS + 1 }, (_, i) => DEFAULT_PORT + i)) {
  const list = ports.map(Number).filter((port) => Number.isInteger(port) && port > 0 && port < 65536);
  return "<!doctype html><html><head><meta charset=\"utf-8\"><title>Miko output</title>" +
    "<style>html,body{margin:0;height:100%;background:#000;overflow:hidden}iframe{position:fixed;inset:0;width:100%;height:100%;border:0;visibility:hidden;background:#000}</style>" +
    "</head><body data-state=\"searching\"><iframe id=\"miko\" title=\"Miko output\"></iframe>" +
    `<script>"use strict";(${loaderMain.toString()})(${JSON.stringify(list)});</script></body></html>`;
}

function createObsRelay({ onViewersChanged } = {}) {
  let server = null;
  let starting = null;
  let port = null;
  let latestFrame = null;
  // Each viewer's response → the newest frame it is waiting for, if it was
  // still receiving an older one when that frame arrived.
  const viewers = new Map();

  function writePart(res, frame) {
    res.write(`--frame\r\nContent-Type: image/png\r\nContent-Length: ${frame.length}\r\n\r\n`);
    res.write(frame);
    res.write("\r\n");
  }

  // At most one frame in flight per viewer. A viewer still receiving an
  // older frame skips ahead: it gets the newest one as soon as its socket
  // drains, so it never falls behind and never misses the black frame Miko
  // sends when a call ends.
  function sendTo(res, frame) {
    if (res.writableNeedDrain) {
      viewers.set(res, frame);
      return;
    }
    viewers.set(res, null);
    writePart(res, frame);
  }

  function openStream(res) {
    res.writeHead(200, {
      "Content-Type": "multipart/x-mixed-replace; boundary=frame",
      "Cache-Control": "no-cache, no-store, must-revalidate",
      Connection: "close"
    });
    // Send the headers now: Node would hold them until the first frame, and
    // the page's fetch() would sit unanswered whenever no call is live.
    res.flushHeaders();
    viewers.set(res, null);
    onViewersChanged?.(viewers.size);
    res.on("drain", () => {
      const waiting = viewers.get(res);
      if (waiting) sendTo(res, waiting);
    });
    const leave = () => {
      if (viewers.delete(res)) onViewersChanged?.(viewers.size);
    };
    res.on("close", leave);
    res.on("error", leave);
    if (latestFrame) sendTo(res, latestFrame);
  }

  function handle(req, res) {
    // Only this machine's own names: a website can't reach the relay by
    // pointing its own domain at 127.0.0.1 (DNS rebinding).
    const expectedHosts = new Set([`127.0.0.1:${port}`, `localhost:${port}`]);
    if (!expectedHosts.has(req.headers.host || "")) {
      res.writeHead(403, { "Cache-Control": "no-store" });
      res.end("Forbidden");
      return;
    }
    const { pathname } = new URL(req.url || "/", "http://127.0.0.1");
    if (pathname === "/stream" || pathname === "/stream.mjpeg") {
      openStream(res);
    } else if (pathname === "/" || pathname === "/index.html") {
      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" });
      res.end(PAGE_HTML);
    } else if (pathname === "/page.js") {
      res.writeHead(200, { "Content-Type": "text/javascript; charset=utf-8", "Cache-Control": "no-store" });
      res.end(PAGE_SCRIPT);
    } else {
      res.writeHead(404);
      res.end();
    }
  }

  function start(requestedPort = DEFAULT_PORT) {
    if (server) return Promise.resolve({ port });
    if (starting) return starting;
    starting = new Promise((resolve, reject) => {
      const candidate = http.createServer(handle);
      const fail = (error) => {
        starting = null;
        reject(error);
      };
      candidate.once("error", fail);
      candidate.listen(requestedPort, "127.0.0.1", () => {
        candidate.removeListener("error", fail);
        server = candidate;
        port = candidate.address().port;
        starting = null;
        resolve({ port });
      });
    });
    return starting;
  }

  // Tries the preferred port, then the next few. On Windows, Hyper-V, WSL or
  // Docker can reserve whole blocks of ports (`netsh interface ipv4 show
  // excludedportrange protocol=tcp`), and listen() then fails with EACCES;
  // any other program can simply be holding the port (EADDRINUSE).
  async function startPreferred(preferredPort = DEFAULT_PORT, spares = SPARE_PORTS) {
    const failures = [];
    for (let candidate = preferredPort; candidate <= preferredPort + spares; candidate += 1) {
      try {
        return await start(candidate);
      } catch (error) {
        if (error.code !== "EADDRINUSE" && error.code !== "EACCES") throw error;
        failures.push(`${candidate} ${error.code}`);
      }
    }
    const error = new Error(`No free local port from ${preferredPort} to ${preferredPort + spares}`);
    error.code = "ENOPORT";
    error.failures = failures;
    throw error;
  }

  async function stop() {
    if (starting) await starting.catch(() => {});
    if (!server) return;
    const closing = server;
    server = null;
    port = null;
    latestFrame = null;
    const hadViewers = viewers.size > 0;
    for (const res of viewers.keys()) res.end();
    viewers.clear();
    if (hadViewers) onViewersChanged?.(0);
    await new Promise((resolve) => {
      closing.close(() => resolve());
      // A viewer that stopped reading would otherwise hold close() open.
      closing.closeAllConnections();
    });
  }

  function pushFrame(frame) {
    if (!server) return;
    latestFrame = frame;
    for (const res of viewers.keys()) sendTo(res, frame);
  }

  // New viewers get nothing until the next frame. Frames already owed to
  // current viewers (the black end-of-call frame) are still delivered.
  function clearFrame() {
    latestFrame = null;
  }

  function bufferedBytes() {
    let total = 0;
    for (const res of viewers.keys()) total += res.writableLength;
    return total;
  }

  return {
    start,
    startPreferred,
    stop,
    pushFrame,
    clearFrame,
    bufferedBytes,
    get running() { return Boolean(server); },
    get port() { return port; },
    get clientCount() { return viewers.size; }
  };
}

module.exports = {
  DEFAULT_PORT,
  SPARE_PORTS,
  PAGE_HTML,
  PAGE_SCRIPT,
  createObsRelay,
  createPartParser,
  loaderHtml
};
