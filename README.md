# DeepLiveCam GUI

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

Miko does not record live sessions. The optional clip recorder/upload path
has been removed, and transient result/OBS frames plus the in-app session
timeline are cleared immediately when a call ends.

## Build

```
npm run build       # bundle lib/renderer-entry.ts -> dist/lucy-session.bundle.js
npm run typecheck   # tsc --noEmit over lib/
npm run dist        # electron-builder package (dmg/zip, nsis, AppImage/deb)
```

Release builds:

```
npx electron-builder --mac --universal
npx electron-builder --win nsis --x64
```

**Building on Windows after cloning:** see "Building on Windows itself,
after cloning" in `AGENTS.md` for the full step-by-step (Node.js/Git
prerequisites, `npm install`, `npx electron-builder --win nsis --x64`,
where the `.exe` lands, and the expected SmartScreen warning on an
unsigned build).
