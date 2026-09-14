# Miko

An Electron desktop app for live character swap and virtual try-on, powered by
fal.ai's Decart Lucy 2.5 realtime model over WebRTC.

The accessible, restrained desktop UI here was designed independently
(see `PRODUCT.md`); the fal.ai integration (WebRTC connect/reconnect,
adaptive resolution, and realtime signaling) lives in
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
lib/*.ts       fal.ai session logic (WebRTC, reconnect, adaptive resolution),
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
($0.02/second). Either can run a full character swap or an outfit-only
task. Miko verifies the account balance before every manual start, retry
and automatic reconnect, keeps a $1 safety floor with a local per-second
spend timer, and uses balance polling only as a cross-check.

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
