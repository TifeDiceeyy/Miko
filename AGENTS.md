# Miko — Agent Guide (Claude Code / Codex / any AI coding assistant)

This file is the fast-start briefing for an AI assistant picking up this
project cold. Read this before touching code. `README.md` has the
user-facing overview; `PRODUCT.md` has the UI/product rationale. This file
is the "what will bite you" doc.

**Active work: `FIX_PLAN.md`** — the full fix plan from the 2026-09-14
review (billing safety, making the swap actually swap, shippable installers,
robustness, tests). Follow its ground rules, above all: **no live fal.ai
sessions without the owner's explicit OK**, since every connect attempt bills
the owner's real account. Note that this file's "Building on Windows" step 4
is currently wrong for a fresh clone — see `FIX_PLAN.md` step 3.4.

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

Run `npm test` for billing-policy and mocked signaling/WebRTC regressions.
Runtime UI changes should also be verified by launching the app; see
"Testing without a human" below.

## Building installers

```
npm run dist:mac                          # renderer + dmg/zip in release/
npm run dist:win                          # renderer + installer .exe in release/
npm run dist                              # builds for the CURRENT host platform only
```

**Building the Windows .exe from macOS requires Wine** (electron-builder's
NSIS target needs it for a Mac host to cross-build). Either install Wine
(`brew install --cask wine-stable`) or build the Windows target on an
actual Windows machine / CI runner — don't assume `--win` works out of the
box on a Mac.

### Building on Windows itself, after cloning

This is the path with no Wine and no cross-build quirks — build natively
on the Windows machine that will run the app.

1. **Install prerequisites** (once):
   - [Node.js LTS](https://nodejs.org) (v20 or newer) — installs `npm`
     alongside it.
   - [Git for Windows](https://git-scm.com/download/win).
2. **Clone and enter the repo** (PowerShell or Command Prompt):
   ```
   git clone https://github.com/TifeDiceeyy/Miko.git
   cd Miko
   ```
3. **Install dependencies:**
   ```
   npm install
   ```
   This also downloads Electron's prebuilt Windows binary automatically —
   no native compiler toolchain needed for this project's own
   dependencies. If `npm install` ever fails on a native module with a
   `node-gyp`/`MSBuild` error (not expected here, but a general Windows/npm
   gotcha), install "Desktop development with C++" via the [Visual Studio
   Build Tools installer](https://visualstudio.microsoft.com/visual-cpp-build-tools/)
   and re-run `npm install`.
4. **Build the installer:**
   ```
   npm run dist:win
   ```
   This builds the renderer bundle first, so a fresh clone cannot produce an
   installer that is missing `dist/lucy-session.bundle.js`.
5. **Find the output:** `release\Miko-<version>-windows-x64.exe`. This is
   an unsigned installer (no code-signing certificate is configured), so
   Windows SmartScreen will show an "unknown publisher" warning the first
   time it's run — click "More info" → "Run anyway". This is expected and
   not a build error.
6. **To just run the app without packaging an installer** (for testing on
   the Windows machine before building a release):
   ```
   npm run dev
   ```
   You'll still need a fal.ai API key entered in Settings → Advanced (or
   set the `FAL_KEY` environment variable) before Start Live will connect
   — see "Install & run" above.

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
   single well-behaved client — it is not automatically proof of a client
   bug. **Correction, found later the same day**: a real client bug (see
   #7 below, the `connectionKey` issue) was self-inflicting at least some
   of these — a leaked, never-torn-down phantom connection from an earlier
   attempt counts against your own account's concurrency limit. That bug
   is fixed; if "Concurrent session limit reached" still shows up
   frequently after this fix, it's genuinely fal-side, not this app.

6. **Never pass a fixed/stable `connectionKey` to `fal.realtime.connect()`
   in a plain (non-React) app.** The SDK caches its entire internal
   signaling state machine in a module-level `Map` keyed by
   `connectionKey`, with **no cleanup or expiry anywhere in the SDK**
   (confirmed by reading `node_modules/@fal-ai/client/src/realtime.js` —
   no `connectionCache.delete()` call exists). A fixed key means every
   `connect()` call — including every automatic reconnect — reuses the
   same cached machine and its internal token-refresh timers for the
   whole process lifetime. This project used to pass a stable key
   (`STABLE_CONNECTION_KEY = "lucy-realtime-singleton"`) to dedupe
   connections across React re-renders — a concern that never applied
   here (no React) and was already redundant with this class's own
   `connecting`/`attemptGeneration` single-flight guard. The stable key
   was removed; `connectionKey` is now omitted entirely so the SDK
   defaults to a fresh `crypto.randomUUID()` per call. **This was a real,
   confirmed cause of a billed session continuing to run server-side with
   no visible connection in the app's own UI** — caught via the user's
   fal.ai dashboard activity log showing an 80+ second request with no
   corresponding "Live" state ever shown on screen. If you ever see that
   symptom again (dashboard shows billed time the UI never reflected),
   check for exactly this pattern before assuming it's fal-side.

6. **Every error path should resolve to a precise, specific message** —
   this app's explicit design goal (`describeError()` in
   `lucy-realtime-session.ts` is the single place that classifies
   balance/auth/network/concurrency errors from raw text). If you add a
   new failure path (a new IPC call, a new fetch), thread the real error
   message through rather than a generic fallback — that has been an
   ongoing, explicit priority in this project, not a one-off ask.

7. **fal SDK 1.10.1 can start or keep a session in the background.** Three
   bugs, all worked around in `open()` and `lib/realtime-socket-guard.ts`:
   - **Delayed sends re-open closed connections.** The 128 ms send throttle
     still fires a pending send after `close()`, and on a closed connection
     any send opens a brand-new connection with a fresh token. The throttle
     also drops every send in a burst except the last, which loses trickled
     ICE candidates. Fix: `throttleInterval: 0`.
   - **Sockets mid-handshake survive `close()`.** `close()` only shuts a
     socket the SDK already tracks as open, so one still mid-handshake
     survives and, once open, sends the queued prompt. Fix: the socket guard
     ties each fal socket to its connection attempt and closes it at
     teardown, even mid-handshake. At most one fal socket can exist at a time.
     A connection closed mid-handshake also *keeps its token*, so a late send
     makes the SDK build a socket without asking for a new token. Blocking
     tokens can't stop that; the guard closes such a socket in its
     constructor, before any network activity.
   - **Token-refresh loops outlive failed connects.** The refresh timer is
     only cleared when leaving `active`, so every failed connect left a
     refresh loop running forever. Fix: no `tokenExpirationSeconds` (no
     refresh at all), and the token provider never settles for an abandoned
     attempt.

   `test/socket-leak.e2e.test.js` proves the fixes against the real SDK.
   fal's unreleased 1.11 alpha fixes these internally; re-check before
   upgrading.

8. **Every Start runs a free network check first** (`lib/network-check.js`,
   main process only, IPC `net:check`). It opens nothing billable: a DNS
   lookup, three TCP connects to `fal.run:443` and local route/VPN queries.
   - macOS: `route -n get <ip>` for the interface fal traffic uses, plus
     `scutil --nc list` for connected VPN services. The 10 or so `utun`
     interfaces macOS creates itself have only link-local addresses, so a
     tunnel counts as a VPN only when it carries fal's route or has a
     routable address.
   - Windows: PowerShell `Find-NetRoute` → `Get-NetAdapter` (matched
     against known VPN adapter names; Hyper-V/WSL adapters don't count) plus
     `Get-VpnConnection` for built-in VPNs. The IP is validated with
     `net.isIP` before it is put in the command. Windows detection is
     exercised by the parser tests and by the CI Windows job, not yet on a
     real PC.
   - A proxy comes from Electron's `resolveProxy` for the fal URL.
   - Offline or unreachable **blocks** Start (no "Start anyway"). A VPN, a
     proxy or a slow link (>400 ms typical connect) **warns** with "Check
     again", "Start anyway" and "Cancel". "Start anyway" is remembered
     until the signature (issue kinds, VPN name, proxy, route interface)
     changes. If the check itself fails, Start goes ahead.
   - After the call starts, two video-link failures in a row (WebRTC
     timeout or ICE failure before going live) stop automatic retries with
     a message naming a VPN, proxy or firewall.
   It only detects and advises — see the rejected features below.

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
