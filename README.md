# Miko

An Electron desktop app for live character swap and virtual try-on, powered by
fal.ai's Decart Lucy 2.5 realtime model over WebRTC.

The accessible, restrained desktop UI here was designed independently
(see `PRODUCT.md`); the fal.ai integration (WebRTC connect, adaptive
resolution, and realtime signaling) lives in
`lib/lucy-realtime-session.ts`.

## Run

```
npm install
npm run dev
```

`npm run dev` builds the renderer's fal.ai bundle (`lib/renderer-entry.ts` →
`dist/lucy-session.bundle.js` via esbuild) and launches Electron. Add your
own fal.ai key in the app's Settings panel (Model settings → fal.ai API key) —
it's stored locally on your machine via Electron's `safeStorage`, never
bundled or shared.

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

## OBS output setup — do this once per install

Miko streams the swapped output to a local, token-protected HTTP relay
(`http://127.0.0.1:<port>`, default port 5590, bound to loopback only) that
OBS's built-in **Browser Source** can read directly — no OBS plugin,
WebSocket, or virtual-cam driver required.

1. In Miko, open **Settings → OBS** and toggle it on. The full URL
   (including its access token) appears in that panel — copy it.
2. In OBS, add a **Browser Source**, paste that URL in, and set its
   **Width** and **Height** to match Miko's current resolution setting
   (default **1280 × 720** — check the "Resolution ceiling" option in
   Miko's settings if you've changed it). The page itself scales the
   stream to fit whatever box OBS gives it (`object-fit: contain`, so the
   full frame is always visible, never cropped or stretched), but OBS
   still captures at the pixel size *you* set here — a smaller Browser
   Source genuinely downscales a good stream, and this app can't override
   that from the page.

**Do this once.** The relay's access token is generated on first use and
persisted to `<userData>/obs-token.txt` — it survives every later launch,
so the URL you paste into OBS keeps working indefinitely. You only need to
redo this step after a fresh install, or if `<userData>` is ever wiped
(uninstall/reinstall, manually deleting app data) — either regenerates the
token, and the previously-saved OBS URL will start returning
`401 Unauthorized` until you paste the new one in. If OBS ever shows a
blank/black source unexpectedly, check Settings → OBS for a new URL before
assuming anything else is wrong.

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
