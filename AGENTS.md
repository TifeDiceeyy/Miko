# Miko — Agent Guide (Claude Code / Codex / any AI coding assistant)

This file is the fast-start briefing for an AI assistant picking up this
project cold. Read this before touching code. `README.md` has the
user-facing overview; `PRODUCT.md` has the UI/product rationale. This file
is the "what will bite you" doc.

## What this app is

Miko is an Electron desktop app for live webcam character-swap and virtual
try-on. It has no local ML model and no local backend — the camera stream
goes straight to **fal.ai's Decart Lucy 2.5 realtime model over WebRTC**,
and the transformed stream comes straight back. fal.ai is the **only**
third-party service this app talks to (confirmed by grepping every
external URL in the codebase — `api.fal.ai`, `rest.fal.ai`, `fal.ai`
dashboard links only).

## Install & run

```
npm install
npm run dev      # builds lib/*.ts -> dist/lucy-session.bundle.js, then launches Electron with DevTools
npm start        # same build step, launches without DevTools
```

You need a fal.ai API key to actually connect (get one at
fal.ai/dashboard/keys). Enter it in the app's Settings → Advanced panel —
it's encrypted at rest via Electron's `safeStorage` (OS keychain) in the
app's userData directory, never committed to this repo. For scripted/CI
use you can set `FAL_KEY` as an env var instead; `main.js`'s `loadFalKey()`
checks that first.

Check account balance at fal.ai/dashboard/billing — the app also surfaces
it in-app (Settings → Advanced), masked behind an eye-toggle by default.

## Verify changes

```
npm run typecheck   # tsc --noEmit over lib/*.ts
npm run check       # node --check on main.js, preload.js, app.js (plain JS, no bundler)
npm run build       # must succeed before `npm run dev`/`start` picks up lib/ changes — esbuild does NOT watch
```

There's no automated test suite. The only reliable way to verify a runtime
change is to actually launch the app and drive it — see "Testing without a
human" below.

## Building installers

```
npx electron-builder --mac --universal    # dmg + zip, output in release/
npx electron-builder --win nsis --x64     # installer .exe, output in release/
npm run dist                              # builds for the CURRENT host platform only
```

**Building the Windows .exe from macOS requires Wine** (electron-builder's
NSIS target needs it for a Mac host to cross-build). Either install Wine
(`brew install --cask wine-stable`) or build the Windows target on an
actual Windows machine / CI runner — don't assume `--win` works out of the
box on a Mac.

## Architecture (see README.md for the diagram)

- `main.js` — Electron main process: fal.ai key storage (`safeStorage`),
  balance lookup, realtime token minting, local OBS MJPEG server. No
  Express, no bundler — plain CommonJS, syntax-checked with `node --check`.
- `preload.js` — narrow `contextBridge` surface (`window.deepLiveCam`).
  Pure passthrough to `ipcRenderer.invoke`/`send` — don't add logic here,
  add it in `main.js` or the renderer.
- `lib/*.ts` — the actual fal.ai/WebRTC session logic, TypeScript, bundled
  by esbuild into `dist/lucy-session.bundle.js` (exposed as
  `window.LucySession` for the plain-JS renderer to consume). This is
  where almost all the hard-won protocol knowledge lives — see below.
- `app.js` — renderer: DOM wiring, no build step, loaded directly by
  `index.html`.

## Hard-won facts — do not rediscover these the hard way

These came from empirical testing against the live fal.ai API and reading
`node_modules/@fal-ai/client`'s own source. They are **not** documented on
fal.ai's public docs pages.

1. **fal's realtime WebRTC signaling protocol** (see the `SignalMessage`
   docstring at the top of `lib/lucy-realtime-session.ts`): the server
   sends `{type:"iceServers", ...}` **first**; only after that does the
   client build its `RTCPeerConnection` and send the one-and-only offer.
   Building the peer connection eagerly, before that push, silently
   breaks the connection. Outgoing ICE candidates use `type:"icecandidate"`
   (no hyphen) — `"ice-candidate"` is wrong and gets silently dropped.

2. **Token minting**: `POST https://rest.fal.ai/tokens/` (not
   `/tokens/realtime`), body `{allowed_apps: [alias], token_expiration:
   <seconds>}` (not `duration`), where `alias` is just the endpoint's last
   path segment (e.g. `"lucy-2-5"`, not `"decart/lucy-2-5/realtime"`).
   Diverging from any of these three causes a 422. See
   `ENDPOINT_ALIASES` in `main.js`.

3. **fal's SDK swallows a rejecting `tokenProvider` internally.** Its
   connection state machine (`node_modules/@fal-ai/client/src/realtime.js`)
   treats a token-fetch rejection as an `unauthorized → idle` transition
   and **never calls your `onError` callback**. Left alone, a 403 balance
   exhausted / 401 bad key / 429 rate-limit at the token-minting stage
   never reaches the user — it just sits until a generic connect timeout.
   Fixed in `open()` in `lucy-realtime-session.ts` by wrapping our own
   `tokenProvider` in a `.catch()` that settles the pending connect promise
   immediately, while still re-throwing so the SDK's internal state
   machine also unwinds correctly.

4. **Account-level errors must not trigger auto-reconnect.** A balance-
   exhausted or auth-failure error is not transient — retrying on the
   normal `RECONNECT_BACKOFF_MS` ladder (1s/2s/4s/8s/16s, ~31s total) just
   restates the identical failure five times before giving up, which looks
   like flapping instead of one clear stop. See
   `isUnrecoverableAccountError()` — treated the same way camera-permission
   errors already are (`isUnrecoverableMediaError()`): surface once, stay
   in a terminal `error` state, require a manual retry.

5. **fal.ai does not publish how long a stale/killed session takes to free
   its concurrency slot server-side.** Checked the realtime docs,
   concurrency-limits docs, and the SDK source — nothing. The tuned
   `CONCURRENCY_RETRY_BACKOFF_MS` schedule (30s/30s/45s/60s/90s, in
   `lib/lucy-config.ts`) is the best available proxy from real-world
   testing, not an official guarantee. `"Concurrent session limit
   reached."` is a normal, retryable condition fal can emit even from a
   single well-behaved client — it is not proof of a client bug.

6. **Every error path should resolve to a precise, specific message** —
   this app's explicit design goal (`describeError()` in
   `lucy-realtime-session.ts` is the single place that classifies
   balance/auth/network/concurrency errors from raw text). If you add a
   new failure path (a new IPC call, a new fetch), thread the real error
   message through rather than a generic fallback — that has been an
   ongoing, explicit priority in this project, not a one-off ask.

## Explicitly rejected features — don't re-propose these

- **No auto-killing other processes** (VPNs, security software) to force
  connectivity. Explicitly declined: it matches malware behavior patterns
  and risks disrupting other legitimate sessions. If connectivity is the
  suspected issue, diagnose and report — never kill things automatically.
- **No session recording.** The app does not record calls. Transient
  result/OBS frames and the in-app activity timeline are cleared
  immediately on disconnect/`beforeunload` (`clearTransientSessionMedia()`
  in `app.js`). Don't reintroduce a clip-recording/upload feature without
  the user explicitly asking again.
- **No OBS plugin, WebSocket, or virtual-cam driver.** OBS output is a
  local MJPEG-over-HTTP server (`main.js`'s `startObsServer`) that OBS's
  built-in Browser Source pulls from directly. Keep it that way.

## Testing without a human

GUI automation via AppleScript screen-clicking is unreliable for this app
(it has repeatedly hit the wrong window). The reliable method used
throughout this project's development is Chrome DevTools Protocol:

```
npx electron . --remote-debugging-port=9333
curl -s http://127.0.0.1:9333/json     # lists targets, find the "Miko" page target id
```

Then drive it with a small Node script using the `ws` global (Node 22+
needs `--experimental-websocket`, or use the `ws` package) — connect to
`ws://127.0.0.1:9333/devtools/page/<TARGET_ID>`, send
`Runtime.enable`/`Runtime.evaluate` CDP commands, and read back
`document.getElementById(...)` state (e.g. `#topStatus`,
`#cameraErrorText`) or call `window.deepLiveCam.*` / `window.LucySession.*`
directly with `awaitPromise: true`. This is how the tokenProvider fix
above was verified end-to-end against the real fal.ai API in under a
second, instead of guessing.

Always add explicit `ws.addEventListener("error"/"close", ...)` handlers
in these scripts — a script without them can exit silently with no output.
