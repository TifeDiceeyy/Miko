# Miko

An Electron desktop app for live character swap and virtual try-on, powered by
fal.ai's Decart Lucy 2.5 realtime model over WebRTC.

The accessible, restrained desktop UI here was designed independently
(see `PRODUCT.md`); the fal.ai integration (WebRTC connect, adaptive
resolution, and realtime signaling) lives in
`lib/lucy-realtime-session.ts`.

## Install

Download the installer for your computer from the latest release:
https://github.com/TifeDiceeyy/Miko/releases/latest

### macOS (Apple silicon and Intel)

1. Download `Miko-<version>-mac-universal.dmg` (or the `.zip`).
2. Open it and drag **Miko** into **Applications**.
3. Open Miko. The app isn't notarized by Apple yet, so macOS may refuse
   to open it the first time. If it does, run this once in Terminal, then
   open Miko again:
   ```sh
   xattr -dr com.apple.quarantine /Applications/Miko.app
   ```
4. Allow camera access when asked (or later in **System Settings →
   Privacy & Security → Camera → Miko**).

### Windows 10 and 11 (64-bit)

1. Download `Miko-<version>-windows-x64.exe`.
2. Run it. The installer isn't code-signed yet, so SmartScreen may show
   "Windows protected your PC": click **More info → Run anyway**.
3. If you have a Miko older than 1.1.0 installed, uninstall it from
   **Settings → Apps**. 1.1.0 and later install as a separate app.
4. Allow camera access when asked (or later in **Settings → Privacy &
   security → Camera**, with "Let desktop apps access your camera" on).

### First run (both)

1. Open **Model settings → API key**, paste your fal.ai key (create one at
   https://fal.ai/dashboard/keys) and press **Save key**. Miko then shows your
   balance. The key is stored encrypted on this computer only. After
   upgrading from a version older than 1.1.0 you need to enter it once
   more.
2. Choose a reference image, then press **Start Live**. Before each Start,
   Miko checks your network for a VPN, a proxy or a blocked connection and
   tells you what to turn off.
3. For OBS, follow "OBS output setup" below. It's a one-time step.

### Updating

Install the new version over the old one (from 1.1.0 on, it upgrades in
place). Your settings, API key and OBS setup stay as they are.

### If something doesn't work

Open **Model settings → API key → Open diagnostic logs** and look at
`miko.log`:

- **Start fails:** each attempt logs one line such as `Connected in 2.3s —
  token 0.5s · service ready 1.6s · …` or `Connect failed after 10.0s — … ·
  waiting on: answer (…)`, showing which step it got stuck on.
- **OBS stays black:** look for `OBS is connected to Miko's output`. If
  it's missing, check that the OBS source uses the OBS page file (below),
  that **Send to OBS** is on, and that a session is live.

## Run from source

```
npm install
npm run dev
```

`npm run dev` builds the renderer's fal.ai bundle (`lib/renderer-entry.ts` →
`dist/lucy-session.bundle.js` via esbuild) and launches Electron. Add your
own fal.ai key in **Model settings → API key → Save key** — it's stored
locally on your machine via Electron's `safeStorage`, never bundled or
shared.

## Architecture

```
main.js        Electron main process — fal.ai key storage, balance lookup,
               short-lived realtime token minting, and local OBS output
preload.js     Narrow contextBridge surface: window.deepLiveCam
lib/*.ts       fal.ai session logic (WebRTC, adaptive resolution),
               bundled by esbuild into dist/lucy-session.bundle.js
index.html     UI shell
styles.css     Design system (OKLCH tokens, light/dark theme, reduced motion)
app.js         Renderer wiring: DOM ↔ the fal.ai session + local Electron APIs
```

There is no local Python backend and no local GPU model — the realtime swap
runs entirely on fal.ai's hosted infrastructure. Your camera stream goes
directly to fal.ai over WebRTC and the transformed stream comes back the
same way; only a short-lived signed token (minted by the main process) and
your prompt/reference image leave your machine.

Miko does not record live sessions. Transient result and OBS frames are
cleared immediately when a call ends. Miko also requests deletion of each
remote request payload when the realtime service supplies a request ID.
The local rotating diagnostic log contains lifecycle text only—never video
frames, reference-image data, or API keys.

Miko offers two models: Miko Pro ($0.04/second) and Miko Lite
($0.02/second). Miko Pro can run a full character swap or an outfit-only
task; Miko Lite is outfit-only (fal's virtual-try-on model doesn't perform
a full character swap — confirmed live, see `AGENTS.md`). Miko verifies the
account balance before every manual start, keeps a $1 safety floor with a
local per-second spend timer, and uses balance polling only as a
cross-check. There is no automatic reconnect: a failed connect attempt
hard-stops completely rather than retrying, since a failed attempt has
already spent real billed money.

Before each Start, Miko runs a quick connection check on the user's own
machine:

- whether traffic to the service goes through a VPN (macOS: route tables
  and connected VPN services; Windows: the adapter the connection really
  uses, known VPN adapters and built-in VPN connections)
- whether a proxy is in the way
- whether the service can be reached, and how fast the link is

If something is likely to get in the way, Miko says what it found and lets
the user turn it off and check again, or start anyway. It never changes
network settings or stops other programs itself.

## OBS output setup — do this once

Miko sends its swapped output to OBS's built-in **Browser Source** — no
OBS plugin, WebSocket, or virtual-cam driver required. **Send to OBS** (in
Miko's Model settings) is on by default and starts with Miko, so the
output goes out whenever a session is live.

1. In Miko's **Model settings**, under **Send to OBS**, press **Show** next
   to the OBS page file: `obs-output.html` in Miko's settings folder
   (`~/Library/Application Support/Miko/` on macOS, `%APPDATA%\Miko\` on
   Windows).
2. In OBS, add a **Browser Source**, tick **Local file**, browse to that
   file, and set **Width** to 1280 and **Height** to 720 (Miko's default
   output size). The picture fits inside whatever size the source is —
   black bars, never cropped or stretched — but OBS captures at the size
   you set, so a smaller source really does lower the quality.

That's the only setup. The page file always loads, even while Miko is
closed: it shows black, finds Miko's output within a few seconds of Miko
starting (whichever app you open first), goes black when a call ends or
Miko closes, and reconnects by itself. Miko's log notes when OBS connects
and disconnects.

A plain URL source (`http://127.0.0.1:7893/`) also works and reconnects by
itself once loaded, but if OBS opens before Miko it can't load the page at
all and needs a right-click → **Refresh**. Sources set up before
2026-09-14 point at the old `http://127.0.0.1:5590/?token=…` and need
replacing.

**Windows** works the same way. The output only accepts connections from
this computer (`127.0.0.1`), so it isn't exposed to the network. If another
program holds port 7893, or Windows has reserved it (Hyper-V, WSL and
Docker can reserve blocks of ports), Miko uses the next free port up to
7902 and says so; the OBS page file finds it by itself, while a URL source
needs the new URL. OBS keeps its scenes in
`%APPDATA%\obs-studio\basic\scenes`.

## Build

```
npm run build       # bundle lib/renderer-entry.ts -> dist/lucy-session.bundle.js
npm run typecheck   # tsc --noEmit over lib/
npm test            # billing policy + mocked signaling/WebRTC regression tests
npm run dist        # electron-builder package (dmg/zip, nsis, AppImage/deb)
npm run dist:mac    # build first, then make universal macOS dmg/zip
npm run dist:win    # build first, then make Windows x64 NSIS installer
```

Release builds:

```
npm run dist:mac
npm run dist:win
```

The macOS configuration includes the camera entitlement and hardened
runtime settings. A public release still needs an Apple Developer ID
certificate and notarization to avoid Gatekeeper warnings. Windows releases
likewise need a trusted code-signing certificate to avoid SmartScreen
warnings; unsigned local builds remain installable after the OS warning is
acknowledged.

For the current ad-hoc macOS build, move Miko to Applications and, if
Gatekeeper quarantines it, run:

```sh
xattr -dr com.apple.quarantine /Applications/Miko.app
```

**Building on Windows after cloning:** see "Building on Windows itself,
after cloning" in `AGENTS.md` for the full step-by-step (Node.js/Git
prerequisites, `npm install`, `npm run dist:win`,
where the `.exe` lands, and the expected SmartScreen warning on an
unsigned build).
