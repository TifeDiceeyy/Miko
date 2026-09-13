const { app, BrowserWindow, dialog, ipcMain, Menu, session, shell, safeStorage } = require("electron");
const { readFile, writeFile, mkdir } = require("node:fs/promises");
const path = require("node:path");
const { pathToFileURL } = require("node:url");
const http = require("node:http");

const isMac = process.platform === "darwin";
let mainWindow = null;

// Kept in sync with lib/lucy-config.ts (that file can't be required directly
// from plain CommonJS main.js, so these two constants are duplicated here).
const REALTIME_ENDPOINTS = {
  characterSwap: "decart/lucy-2-5/realtime",
  virtualTryOn: "decart/lucy2-vton/realtime"
};
const TOKEN_DURATION_SECONDS = 120;

// Permanent default for a fresh install (no settings.json yet) — the exact
// fidelity-focused phrasing the master prompt itself recommended for
// keeping swaps literal to the reference rather than drifting. Once the
// user saves their own prompt (even an empty one), this no longer applies.
const DEFAULT_PROMPT =
  "Replace the entire person in the live camera feed with the exact person or character shown in the reference image, including their face, facial features, hair, skin tone, body appearance, clothing, colors, materials, and silhouette. Keep the same identity and character design stable and consistent across every frame. Preserve the live person's pose, expression, hand motion, camera angle, lighting, and background. Do not invent, blend, or morph facial features, clothing, or identity.";

function isTrustedSender(event) {
  const senderUrl = event.senderFrame?.url || "";
  return senderUrl.startsWith(pathToFileURL(__dirname).toString());
}

// ---------------------------------------------------------------------
// OBS output — serves the transformed feed as an MJPEG stream over local
// HTTP so OBS's built-in Browser Source can pull it in directly. No OBS
// plugin, no NDI/Syphon driver, no OBS WebSocket needed: point a Browser
// Source at the URL this returns and it just works.
// ---------------------------------------------------------------------

const OBS_DEFAULT_PORT = 5590;
let obsServer = null;
let obsPort = null;
let latestFrame = null;
const obsClients = new Set();

const OBS_PAGE_HTML =
  "<!doctype html><html><head><meta charset=\"utf-8\">" +
  "<style>html,body{margin:0;height:100%;background:#000;overflow:hidden}img{width:100%;height:100%;object-fit:contain;display:block}</style>" +
  "</head><body><img src=\"/stream.mjpeg\" alt=\"\" /></body></html>";

function writeMjpegFrame(res, buffer) {
  res.write(`--frame\r\nContent-Type: image/jpeg\r\nContent-Length: ${buffer.length}\r\n\r\n`);
  res.write(buffer);
  res.write("\r\n");
}

function startObsServer(port) {
  return new Promise((resolve, reject) => {
    if (obsServer) {
      resolve({ port: obsPort });
      return;
    }
    const server = http.createServer((req, res) => {
      if (req.url === "/stream.mjpeg") {
        res.writeHead(200, {
          "Content-Type": "multipart/x-mixed-replace; boundary=frame",
          "Cache-Control": "no-cache, no-store, must-revalidate",
          Connection: "close"
        });
        obsClients.add(res);
        if (latestFrame) writeMjpegFrame(res, latestFrame);
        req.on("close", () => obsClients.delete(res));
      } else if (req.url === "/" || req.url === "/index.html") {
        res.writeHead(200, { "Content-Type": "text/html" });
        res.end(OBS_PAGE_HTML);
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
    mode: Object.values(REALTIME_ENDPOINTS).includes(source.mode) ? source.mode : REALTIME_ENDPOINTS.characterSwap,
    resolution: [512, 768, 1024].includes(Number(source.resolution)) ? Number(source.resolution) : 1024,
    prompt: String(source.prompt || "").slice(0, 2000),
    enablePromptExpansion: Boolean(source.enablePromptExpansion),
    cameraId: String(source.cameraId || "").slice(0, 500),
    theme: source.theme === "light" ? "light" : "dark"
  };
}

function settingsPath() {
  return path.join(app.getPath("userData"), "settings.json");
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
  const template = [
    ...(isMac ? [{ role: "appMenu" }] : []),
    { role: "fileMenu" },
    { role: "editMenu" },
    { role: "viewMenu" },
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
      webSecurity: true
    }
  });

  mainWindow.loadFile("index.html");
  mainWindow.once("ready-to-show", () => mainWindow?.show());
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (url.startsWith("https://")) shell.openExternal(url);
    return { action: "deny" };
  });

  if (process.argv.includes("--dev")) {
    mainWindow.webContents.openDevTools({ mode: "detach" });
  }
}

app.whenReady().then(() => {
  createMenu();

  session.defaultSession.setPermissionCheckHandler((webContents, permission) => {
    const trusted = webContents?.getURL().startsWith(pathToFileURL(__dirname).toString());
    return Boolean(trusted && permission === "media");
  });
  session.defaultSession.setPermissionRequestHandler((webContents, permission, callback) => {
    const trusted = webContents.getURL().startsWith(pathToFileURL(__dirname).toString());
    callback(trusted && permission === "media");
  });

  createWindow();
  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on("window-all-closed", () => {
  if (!isMac) app.quit();
});

app.on("before-quit", () => {
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
    return sanitizeSettings({ prompt: DEFAULT_PROMPT });
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
    throw new Error(`Could not reach fal.ai to request a token (network error${cause}).`);
  }
  if (!response.ok) {
    const detail = await response.text().catch(() => "");
    throw new Error(`fal token request failed (${response.status}): ${detail}`);
  }

  let data;
  try {
    data = await response.json();
  } catch (error) {
    throw new Error(`fal.ai returned an unreadable (non-JSON) token response: ${error.message}`);
  }
  if (typeof data === "string") return data;
  if (data && typeof data.detail === "string") return data.detail; // old proxy wrapping, per the SDK's own defensive check
  throw new Error(`Unexpected token response shape: ${JSON.stringify(data)}`);
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
});

ipcMain.handle("obs:status", (event) => {
  if (!isTrustedSender(event)) return { running: false };
  return obsServer ? { running: true, url: `http://127.0.0.1:${obsPort}/` } : { running: false };
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
