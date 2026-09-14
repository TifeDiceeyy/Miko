const { app, BrowserWindow, dialog, ipcMain, Menu, powerMonitor, session, shell, safeStorage, systemPreferences } = require("electron");
const { appendFile, copyFile, mkdir, readFile, stat, writeFile } = require("node:fs/promises");
const path = require("node:path");
const { pathToFileURL } = require("node:url");
const http = require("node:http");

const isMac = process.platform === "darwin";
let mainWindow = null;
const appRootUrl = pathToFileURL(`${__dirname}${path.sep}`).toString();

const hasSingleInstanceLock = app.requestSingleInstanceLock();
if (!hasSingleInstanceLock) app.quit();

// Model endpoints and default prompts live in lib/session-presets.js, shared
// with the renderer so the two copies can't drift. Must stay in sync with
// REALTIME_ENDPOINTS in lib/lucy-config.ts (a TS file main.js can't require).
const presets = require("./lib/session-presets");
const REALTIME_ENDPOINTS = {
  characterSwap: presets.MODELS.pro,
  virtualTryOn: presets.MODELS.lite
};
const TOKEN_DURATION_SECONDS = 120;

function isTrustedSender(event) {
  const senderUrl = event.senderFrame?.url || "";
  return senderUrl.startsWith(appRootUrl);
}

// ---------------------------------------------------------------------
// OBS output — serves the transformed feed as an MJPEG stream over local
// HTTP so OBS's built-in Browser Source can pull it in directly. No OBS
// plugin, no NDI/Syphon driver, no OBS WebSocket needed: point a Browser
// Source at the URL this returns and it just works.
// ---------------------------------------------------------------------

// No auth token: an explicit owner decision (2026-09-14), trading away the
// protection it gave (stopping some other local process, or a website open
// in a normal browser tab, from quietly fetching this URL and reading the
// live swap feed) for a plain, permanent, human-typeable URL. If that
// trade ever needs revisiting, `git log` this comment's commit for the
// original token-based implementation to restore.
const OBS_DEFAULT_PORT = 7893;
let obsServer = null;
let obsPort = null;
let latestFrame = null;
const obsClients = new Set();

function obsPageHtml() {
  return "<!doctype html><html><head><meta charset=\"utf-8\">" +
  "<meta http-equiv=\"Content-Security-Policy\" content=\"default-src 'none'; img-src 'self'\">" +
  "<style>html,body{margin:0;height:100%;background:#000;overflow:hidden}img{width:100%;height:100%;object-fit:contain;display:block}</style>" +
  "</head><body><img src=\"/stream.mjpeg\" alt=\"\" /></body></html>";
}

// PNG frames, not JPEG, over the same multipart/x-mixed-replace transport —
// Chromium (which OBS's Browser Source embeds) decodes an arbitrary
// per-part Content-Type here just fine, it doesn't have to be JPEG. See
// app.js's startObsFrameLoop() for why: canvas.toBlob's JPEG encoder always
// applies 4:2:0 chroma subsampling regardless of the quality argument
// (browsers expose no way to disable it) — a real, visible softening on
// faces specifically. This is the exact same fix already proven in the
// sibling Swapy project's OBS relay.
function writeMjpegFrame(res, buffer) {
  res.write(`--frame\r\nContent-Type: image/png\r\nContent-Length: ${buffer.length}\r\n\r\n`);
  res.write(buffer);
  res.write("\r\n");
}

async function startObsServer(port) {
  if (obsServer) {
    return { port: obsPort };
  }
  return new Promise((resolve, reject) => {
    const server = http.createServer((req, res) => {
      const expectedHosts = new Set([`127.0.0.1:${port}`, `localhost:${port}`]);
      if (!expectedHosts.has(req.headers.host || "")) {
        res.writeHead(403, { "Cache-Control": "no-store" });
        res.end("Forbidden");
        return;
      }
      const requestUrl = new URL(req.url || "/", `http://${req.headers.host}`);
      if (requestUrl.pathname === "/stream.mjpeg") {
        res.writeHead(200, {
          "Content-Type": "multipart/x-mixed-replace; boundary=frame",
          "Cache-Control": "no-cache, no-store, must-revalidate",
          Connection: "close"
        });
        obsClients.add(res);
        if (latestFrame) writeMjpegFrame(res, latestFrame);
        req.on("close", () => obsClients.delete(res));
      } else if (requestUrl.pathname === "/" || requestUrl.pathname === "/index.html") {
        res.writeHead(200, { "Content-Type": "text/html", "Cache-Control": "no-store" });
        res.end(obsPageHtml());
      } else {
        res.writeHead(404);
        res.end();
      }
    });
    server.once("error", (err) => {
      obsServer = null;
      obsPort = null;
      reject(err);
    });
    server.listen(port, "127.0.0.1", () => {
      obsServer = server;
      obsPort = port;
      resolve({ port });
    });
  });
}

async function stopObsServer() {
  if (!obsServer) return;
  for (const res of obsClients) res.end();
  obsClients.clear();
  await new Promise((resolve) => obsServer.close(resolve));
  obsServer = null;
  obsPort = null;
  latestFrame = null;
}

function sanitizeSettings(value) {
  const source = value && typeof value === "object" ? value : {};
  return {
    ...presets.resolveSelection(source),
    // Landscape capture widths matching RESOLUTION_STEPS in lib/lucy-config.ts
    // (Lucy 2.5's documented native resolution is 1280x720, not square — a
    // legacy 512/768/1024 value from before this change falls back to 1280).
    resolution: [640, 960, 1280].includes(Number(source.resolution)) ? Number(source.resolution) : 1280,
    prompt: String(source.prompt || "").slice(0, 2000),
    // fal/Decart's own docs: prompt expansion "is on by default; keep it
    // on" — it rewrites the instruction to fit each frame/reference, which
    // is what keeps a swap stable instead of flickering. Only an explicit
    // `false` from a real saved setting turns it off; an absent field
    // (fresh install, or a settings file from before this field existed)
    // defaults to Decart's own recommended on, not off.
    enablePromptExpansion: source.enablePromptExpansion === undefined ? true : Boolean(source.enablePromptExpansion),
    cameraId: String(source.cameraId || "").slice(0, 500),
    theme: source.theme === "light" ? "light" : "dark",
    // Restored on launch so the relay auto-starts if it was on last time —
    // see app.js's init(). The URL it's served at no longer changes (no
    // token, fixed port), so there's nothing stale to worry about.
    obsEnabled: Boolean(source.obsEnabled)
  };
}

function settingsPath() {
  return path.join(app.getPath("userData"), "settings.json");
}

// Small rotating lifecycle log for installed-build diagnostics. It contains
// text events only—never video frames, reference-image data, or API keys.
const MAX_LOG_BYTES = 1024 * 1024;
let logQueue = Promise.resolve();

function redactLogText(value) {
  return String(value || "")
    .replace(/data:image\/[^;]+;base64,[A-Za-z0-9+/=_-]+/gi, "[image omitted]")
    .replace(/\bKey\s+[A-Za-z0-9_.:-]+/gi, "Key [redacted]")
    .replace(/[0-9a-f-]{36}:[0-9a-f]{32}/gi, "[key redacted]")
    .replace(/fal_jwt_token=[^&\s]+/gi, "fal_jwt_token=[redacted]")
    .slice(0, 1200);
}

function logPath() {
  return path.join(app.getPath("userData"), "logs", "miko.log");
}

function logAppEvent(level, message) {
  const safeLevel = ["info", "warn", "error"].includes(level) ? level : "info";
  const line = `${new Date().toISOString()} ${safeLevel.toUpperCase()} ${redactLogText(message)}\n`;
  logQueue = logQueue.then(async () => {
    const filePath = logPath();
    await mkdir(path.dirname(filePath), { recursive: true });
    const size = await stat(filePath).then((entry) => entry.size).catch(() => 0);
    if (size + Buffer.byteLength(line) > MAX_LOG_BYTES) {
      await copyFile(`${filePath}.2`, `${filePath}.3`).catch(() => {});
      await copyFile(`${filePath}.1`, `${filePath}.2`).catch(() => {});
      await copyFile(filePath, `${filePath}.1`).catch(() => {});
      await writeFile(filePath, "", "utf8");
    }
    await appendFile(filePath, line, "utf8");
  }).catch((error) => console.error("Unable to write application log", error));
}

// ---------------------------------------------------------------------
// fal.ai key storage — this app runs entirely on the user's machine, so
// there's no server to hide a shared key behind. Each user supplies their
// own fal.ai key via Settings; it's encrypted at rest with Electron's
// safeStorage (OS keychain-backed) when available.
// ---------------------------------------------------------------------

function falKeyPath() {
  return path.join(app.getPath("userData"), "fal-key.store");
}

async function saveFalKey(key) {
  const filePath = falKeyPath();
  await mkdir(path.dirname(filePath), { recursive: true });
  if (safeStorage.isEncryptionAvailable()) {
    await writeFile(filePath, safeStorage.encryptString(key));
  } else {
    console.warn(`[fal-key] OS encryption unavailable — storing the key in plain text at ${filePath}`);
    await writeFile(filePath, key, "utf8");
  }
}

// Returns the key string, or throws with a precise, user-facing reason if a
// key file exists but can't actually be used — distinct from "no key was
// ever saved" (see fal:get-key-status / fal:get-token, which treat
// `undefined` as exactly that: nothing configured yet).
async function loadFalKey() {
  if (process.env.FAL_KEY) return process.env.FAL_KEY;
  let raw;
  try {
    raw = await readFile(falKeyPath());
  } catch (error) {
    if (error.code !== "ENOENT") {
      console.error("Unable to read stored fal.ai key file", error);
      throw new Error(`Could not read the saved API key from disk (${error.code || error.message}). Try re-entering it in Settings.`);
    }
    return undefined;
  }
  if (safeStorage.isEncryptionAvailable()) {
    try {
      return safeStorage.decryptString(raw);
    } catch (error) {
      // Falling back to treating the encrypted bytes as a literal key string
      // would silently send garbage to fal.ai and show up as a confusing
      // 401 — a decrypt failure (OS keychain reset, key file copied to a
      // different machine/user account) needs its own precise message
      // instead of masquerading as a bad key.
      console.error("Unable to decrypt stored fal.ai key", error);
      throw new Error("The saved API key could not be decrypted (OS keychain data changed or unavailable). Re-enter your key in Settings.");
    }
  }
  return raw.toString("utf8");
}

function createMenu() {
  const viewSubmenu = [
    { role: "resetZoom" },
    { role: "zoomIn" },
    { role: "zoomOut" },
    { type: "separator" },
    { role: "togglefullscreen" }
  ];
  if (process.argv.includes("--dev")) {
    viewSubmenu.unshift({ role: "reload" }, { role: "forceReload" }, { role: "toggleDevTools" }, { type: "separator" });
  }
  const template = [
    ...(isMac ? [{ role: "appMenu" }] : []),
    { role: "fileMenu" },
    { role: "editMenu" },
    { label: "View", submenu: viewSubmenu },
    { role: "windowMenu" }
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1480,
    height: 920,
    minWidth: 1080,
    minHeight: 700,
    show: false,
    backgroundColor: "#071018",
    frame: isMac,
    titleBarStyle: isMac ? "hiddenInset" : "hidden",
    trafficLightPosition: { x: 18, y: 18 },
    webPreferences: {
      preload: path.join(__dirname, "preload.js"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      webSecurity: true,
      backgroundThrottling: false
    }
  });

  mainWindow.loadFile("index.html");
  mainWindow.once("ready-to-show", () => mainWindow?.show());
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (url.startsWith("https://")) shell.openExternal(url);
    return { action: "deny" };
  });
  // Dropping a file or link on the window would otherwise replace the app
  // with that page. Only the scheme is logged, never the path or URL.
  mainWindow.webContents.on("will-navigate", (event, url) => {
    if (url === mainWindow?.webContents.getURL()) return;
    event.preventDefault();
    let scheme = "unknown";
    try { scheme = new URL(url).protocol; } catch {}
    logAppEvent("warn", `Blocked the window from navigating away from Miko (${scheme})`);
  });

  if (process.argv.includes("--dev")) {
    mainWindow.webContents.openDevTools({ mode: "detach" });
  }
}

// Without these, a crash leaves a blank window and nothing in the log.
process.on("uncaughtException", (error) => {
  logAppEvent("error", `Main process error: ${error?.stack || error}`);
});
process.on("unhandledRejection", (reason) => {
  logAppEvent("error", `Main process unhandled rejection: ${reason?.stack || reason}`);
});

let lastWindowCrashAt = 0;
app.on("render-process-gone", (_event, webContents, details) => {
  logAppEvent("error", `Window process gone (${details.reason}, exit code ${details.exitCode})`);
  if (details.reason === "clean-exit" || webContents.isDestroyed()) return;
  // The crash already closed any live session (its sockets died with the
  // process). Reload once; a second crash within a minute stays down so it
  // can't loop.
  const now = Date.now();
  const reloadAllowed = now - lastWindowCrashAt > 60000;
  lastWindowCrashAt = now;
  void dialog.showMessageBox({
    type: "error",
    title: "Miko stopped unexpectedly",
    message: `Miko's window stopped unexpectedly (${details.reason}).`,
    detail: reloadAllowed
      ? "Any live session was ended. The window will reload. Details are in the diagnostic log."
      : "It stopped twice in a minute, so it won't reload automatically. Restart Miko; details are in the diagnostic log."
  });
  if (reloadAllowed) webContents.reload();
});
app.on("child-process-gone", (_event, details) => {
  if (details.reason !== "clean-exit") logAppEvent("warn", `${details.type} process gone (${details.reason})`);
});

if (hasSingleInstanceLock) app.on("second-instance", () => {
  if (!mainWindow) return;
  if (mainWindow.isMinimized()) mainWindow.restore();
  mainWindow.show();
  mainWindow.focus();
});

// Builds before the rename kept data under the old app name. Settings carry
// over; the saved key can't, since it's encrypted to the old app identity
// and the new one can't decrypt it, so the user re-enters it once.
async function migrateLegacySettings() {
  const target = settingsPath();
  try {
    await stat(target);
    return;
  } catch {}
  try {
    await mkdir(path.dirname(target), { recursive: true });
    await copyFile(path.join(app.getPath("appData"), "deeplivecam-gui", "settings.json"), target);
    logAppEvent("info", "Copied settings from the previous app folder (deeplivecam-gui)");
  } catch {}
}

if (hasSingleInstanceLock) app.whenReady().then(async () => {
  await migrateLegacySettings();
  createMenu();

  session.defaultSession.setPermissionCheckHandler((webContents, permission) => {
    const trusted = webContents?.getURL().startsWith(appRootUrl);
    return Boolean(trusted && permission === "media");
  });
  session.defaultSession.setPermissionRequestHandler((webContents, permission, callback) => {
    const trusted = webContents.getURL().startsWith(appRootUrl);
    callback(trusted && permission === "media");
  });

  createWindow();
  const suspendSession = (reason) => {
    logAppEvent("info", `Session stopped because the system ${reason}`);
    mainWindow?.webContents.send("app:system-suspend", reason);
  };
  powerMonitor.on("suspend", () => suspendSession("suspended"));
  powerMonitor.on("lock-screen", () => suspendSession("screen locked"));
  logAppEvent("info", `Miko ${app.getVersion()} started on ${process.platform}/${process.arch}`);
  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on("window-all-closed", () => {
  if (!isMac) app.quit();
});

app.on("before-quit", () => {
  logAppEvent("info", "Miko is quitting");
  void stopObsServer();
});

ipcMain.handle("window:control", (event, action) => {
  if (!isTrustedSender(event)) return false;
  const window = BrowserWindow.fromWebContents(event.sender);
  if (!window) return false;
  if (action === "minimize") window.minimize();
  if (action === "maximize") window.isMaximized() ? window.unmaximize() : window.maximize();
  if (action === "close") window.close();
  return true;
});

ipcMain.handle("dialog:pick-media", async (event) => {
  if (!isTrustedSender(event)) return null;
  let result;
  try {
    result = await dialog.showOpenDialog(mainWindow, {
      title: "Choose a reference image",
      properties: ["openFile"],
      filters: [
        { name: "Images", extensions: ["png", "jpg", "jpeg", "webp"] },
        { name: "All Files", extensions: ["*"] }
      ]
    });
  } catch (error) {
    console.error("Unable to open file picker", error);
    throw new Error(`Could not open the file picker: ${error.message}`);
  }
  if (result.canceled || result.filePaths.length === 0) return null;
  const filePath = result.filePaths[0];
  return { name: path.basename(filePath), path: filePath, url: pathToFileURL(filePath).toString() };
});

ipcMain.handle("settings:load", async (event) => {
  if (!isTrustedSender(event)) return null;
  try {
    const json = await readFile(settingsPath(), "utf8");
    return sanitizeSettings(JSON.parse(json));
  } catch (error) {
    if (error.code !== "ENOENT") console.error("Unable to load settings", error);
    return sanitizeSettings({ prompt: presets.DEFAULT_PROMPTS.character });
  }
});

ipcMain.handle("settings:save", async (event, value) => {
  if (!isTrustedSender(event)) return { ok: false, message: "Untrusted settings request." };
  try {
    const settings = sanitizeSettings(value);
    await mkdir(path.dirname(settingsPath()), { recursive: true });
    await writeFile(settingsPath(), JSON.stringify(settings, null, 2), "utf8");
    return { ok: true, settings };
  } catch (error) {
    console.error("Unable to save settings", error);
    return { ok: false, message: `Settings could not be saved: ${error.code || error.message}` };
  }
});

ipcMain.handle("app:info", (event) => {
  if (!isTrustedSender(event)) return null;
  return {
    version: app.getVersion(),
    platform: process.platform,
    architecture: process.arch,
    userDataPath: app.getPath("userData")
  };
});

ipcMain.on("app:log", (event, level, message) => {
  if (!isTrustedSender(event)) return;
  logAppEvent(level, message);
});

ipcMain.handle("media:camera-access", (event) => {
  if (!isTrustedSender(event)) return "unknown";
  return isMac ? systemPreferences.getMediaAccessStatus("camera") : "unknown";
});

ipcMain.handle("media:open-camera-settings", async (event) => {
  if (!isTrustedSender(event) || !isMac) return false;
  await shell.openExternal("x-apple.systempreferences:com.apple.preference.security?Privacy_Camera");
  return true;
});

ipcMain.handle("log:open-folder", async (event) => {
  if (!isTrustedSender(event)) return false;
  const folder = path.dirname(logPath());
  await mkdir(folder, { recursive: true });
  const error = await shell.openPath(folder);
  if (error) throw new Error(error);
  return true;
});

// ---------------------------------------------------------------------
// fal.ai — key management, balance lookup, and realtime token minting.
// See lib/lucy-realtime-session.ts for the WebRTC side in the renderer.
// ---------------------------------------------------------------------

ipcMain.handle("fal:get-key-status", async (event) => {
  if (!isTrustedSender(event)) return { hasKey: false };
  try {
    return { hasKey: Boolean(await loadFalKey()) };
  } catch (error) {
    // A corrupted/undecryptable key still counts as "no usable key" for
    // this status check, but the precise reason matters for fal:get-token's
    // rejection, not here — this is a passive status probe, not the action
    // that should announce it.
    console.error("fal:get-key-status:", error.message);
    return { hasKey: false, keyError: error.message };
  }
});

ipcMain.handle("fal:get-balance", async (event) => {
  if (!isTrustedSender(event)) return null;
  let key;
  try {
    key = await loadFalKey();
  } catch (error) {
    // Non-fatal by design (see below) — but a corrupted key is exactly the
    // kind of thing that otherwise silently shows "no balance available"
    // forever. Log it clearly so it's not invisible to whoever's debugging.
    console.warn("fal:get-balance: could not load key —", error.message);
    return null;
  }
  if (!key) return null;

  let response;
  try {
    response = await fetch("https://api.fal.ai/v1/account/billing?expand=credits", {
      headers: { Authorization: `Key ${key}` }
    });
  } catch (error) {
    console.warn(`Balance check failed (network error: ${error?.cause?.code || error.message})`);
    return null;
  }
  if (!response.ok) {
    // Not fatal — the balance check is a courtesy notification, not a
    // requirement for the app to function. A key without billing-read
    // scope (403) or a transient error shouldn't block anything.
    console.warn(`Balance check failed (${response.status})`);
    return null;
  }
  let data;
  try {
    data = await response.json();
  } catch (error) {
    console.warn("Balance check failed (invalid JSON response)", error);
    return null;
  }
  if (!data?.credits) return null;
  return { balance: data.credits.current_balance, currency: data.credits.currency };
});

ipcMain.handle("fal:save-key", async (event, key) => {
  if (!isTrustedSender(event)) throw new Error("Untrusted request.");
  try {
    await saveFalKey(String(key || "").trim());
  } catch (error) {
    console.error("Unable to save fal.ai key", error);
    throw new Error(`Could not save the API key to disk (${error.code || error.message}).`);
  }
  return { hasKey: Boolean(await loadFalKey()) };
});

// Matches @fal-ai/client's own getTemporaryAuthToken() (src/auth.js) exactly:
// POST /tokens/ (not /tokens/realtime), body { allowed_apps, token_expiration }
// (not duration), where allowed_apps takes the endpoint's *alias* segment
// only (e.g. "lucy-2-5", not "decart/lucy-2-5/realtime"). Diverging from any
// of these three is what caused a 422 the first time this was tried against
// the real API — the master-prompt spec for this call turned out to be wrong
// in all three respects, discovered by reading the SDK's own source.
const ENDPOINT_ALIASES = {
  [REALTIME_ENDPOINTS.characterSwap]: "lucy-2-5",
  [REALTIME_ENDPOINTS.virtualTryOn]: "lucy2-vton"
};

ipcMain.handle("fal:get-token", async (event, requestedApp) => {
  if (!isTrustedSender(event)) throw new Error("Untrusted request.");
  const key = await loadFalKey();
  if (!key) throw new Error("No API key configured. Add one in Settings.");

  // Never forward a renderer-supplied app string unvalidated — a
  // compromised renderer could otherwise get a token scoped to an app it
  // has no business touching. Only the two endpoints this app actually
  // uses are ever allowed, regardless of what's requested.
  const alias = ENDPOINT_ALIASES[requestedApp] ?? ENDPOINT_ALIASES[REALTIME_ENDPOINTS.characterSwap];

  let response;
  try {
    response = await fetch("https://rest.fal.ai/tokens/", {
      method: "POST",
      headers: { Authorization: `Key ${key}`, "Content-Type": "application/json", Accept: "application/json" },
      body: JSON.stringify({ allowed_apps: [alias], token_expiration: TOKEN_DURATION_SECONDS })
    });
  } catch (err) {
    // Node's fetch throws "TypeError: fetch failed" with the actual DNS/
    // connection reason buried in .cause — surface that instead of the
    // generic wrapper message, or the user just sees "fetch failed".
    const cause = err && err.cause ? `: ${err.cause.code || err.cause.message || err.cause}` : "";
    throw new Error(`Could not reach the realtime service to request a token (network error${cause}).`);
  }
  if (!response.ok) {
    const detail = await response.text().catch(() => "");
    logAppEvent("error", `Realtime token request failed (${response.status}): ${detail}`);
    if (/exhausted balance|insufficient (credit|balance|fund)|payment required/i.test(detail)) {
      throw new Error("Account balance is exhausted — top up to continue.");
    }
    if (response.status === 401 || response.status === 403) {
      throw new Error("Authentication failed — check the API key in Settings.");
    }
    if (response.status === 429) {
      throw new Error("The account is temporarily rate limited. Wait, then try again.");
    }
    throw new Error(`Realtime authorization failed (${response.status}).`);
  }

  let data;
  try {
    data = await response.json();
  } catch (error) {
    throw new Error(`The realtime service returned an unreadable token response: ${error.message}`);
  }
  if (typeof data === "string") return data;
  if (data && typeof data.detail === "string") return data.detail; // old proxy wrapping, per the SDK's own defensive check
  throw new Error(`Unexpected token response shape: ${JSON.stringify(data)}`);
});

ipcMain.handle("fal:delete-request-payload", async (event, requestId) => {
  if (!isTrustedSender(event)) throw new Error("Untrusted request.");
  const safeRequestId = String(requestId || "");
  if (!/^[A-Za-z0-9-]{8,100}$/.test(safeRequestId)) throw new Error("Invalid request ID.");
  const key = await loadFalKey();
  if (!key) throw new Error("No API key configured.");
  const response = await fetch(`https://api.fal.ai/v1/models/requests/${encodeURIComponent(safeRequestId)}/payloads`, {
    method: "DELETE",
    headers: { Authorization: `Key ${key}`, "Idempotency-Key": `miko-${safeRequestId}` }
  });
  if (!response.ok && response.status !== 404) {
    throw new Error(`Request-payload deletion failed (${response.status}).`);
  }
  logAppEvent("info", `Deleted remote request payload ${safeRequestId}`);
  return { ok: true };
});

const networkCheck = require("./lib/network-check");

ipcMain.handle("net:check", async (event) => {
  if (!isTrustedSender(event)) throw new Error("Untrusted request.");
  const result = await networkCheck.checkNetwork({
    resolveProxy: (url) => session.defaultSession.resolveProxy(url)
  });
  const issues = [...result.blockers, ...result.warnings].map((issue) => issue.kind);
  const latency = result.typicalConnectMs != null ? `, ${Math.round(result.typicalConnectMs)} ms to the service` : "";
  logAppEvent(issues.length ? "warn" : "info", `Connection check: ${issues.length ? issues.join(", ") : "clear"}${latency}`);
  return result;
});

ipcMain.handle("shell:open-external", (event, url) => {
  if (!isTrustedSender(event)) return;
  if (typeof url === "string" && url.startsWith("https://")) shell.openExternal(url);
});

ipcMain.handle("obs:start", async (event, requestedPort) => {
  if (!isTrustedSender(event)) throw new Error("Untrusted request.");
  const port = Number(requestedPort) || OBS_DEFAULT_PORT;
  try {
    const { port: boundPort } = await startObsServer(port);
    logAppEvent("info", `OBS output started on localhost port ${boundPort}`);
    return { url: `http://127.0.0.1:${boundPort}/` };
  } catch (err) {
    throw new Error(
      err.code === "EADDRINUSE"
        ? `Port ${port} is already in use — try a different port.`
        : `Could not start OBS output: ${err.message}`
    );
  }
});

ipcMain.handle("obs:stop", async (event) => {
  if (!isTrustedSender(event)) return;
  await stopObsServer();
  logAppEvent("info", "OBS output stopped");
});

ipcMain.handle("obs:status", (event) => {
  if (!isTrustedSender(event)) return { running: false };
  return obsServer
    ? { running: true, url: `http://127.0.0.1:${obsPort}/` }
    : { running: false };
});

// Hot path — called ~15x/second while OBS output is on, so this is a
// fire-and-forget `send`, not an `invoke` round trip.
ipcMain.on("obs:frame", (event, buffer) => {
  if (!isTrustedSender(event) || !obsServer) return;
  latestFrame = Buffer.from(buffer);
  for (const res of obsClients) writeMjpegFrame(res, latestFrame);
});

ipcMain.on("obs:clear-frame", (event) => {
  if (!isTrustedSender(event)) return;
  latestFrame = null;
});
