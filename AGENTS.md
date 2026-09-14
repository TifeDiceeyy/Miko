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

4. **There is no auto-reconnect of any kind (changed 2026-09-14).** Every
   `connect()` is a single attempt: success goes live, any failure —
   account error, video-link timeout, mid-session ICE break, signaling
   error — tears the session down completely and lands in a terminal
   `error` state. This used to retry on a backoff ladder (`RECONNECT_BACKOFF_MS`
   / `CONCURRENCY_RETRY_BACKOFF_MS`, both now deleted from
   `lib/lucy-config.ts`); the owner explicitly removed that, since a failed
   attempt has already spent real billed money and silently retrying (and
   potentially billing again) on the user's behalf isn't this app's call to
   make. `isUnrecoverableAccountError()` still exists and is still used to
   classify signaling errors, just no longer to gate a retry that no longer
   happens.

5. **fal.ai does not publish how long a stale/killed session takes to free
   its concurrency slot server-side.** Checked the realtime docs,
   concurrency-limits docs, and the SDK source — nothing. `"Concurrent
   session limit reached."` is a normal condition fal can emit even from a
   single well-behaved client — it is not automatically proof of a client
   bug. **Correction, found later the same day**: a real client bug (see
   #7 below, the `connectionKey` issue) was self-inflicting at least some
   of these — a leaked, never-torn-down phantom connection from an earlier
   attempt counts against your own account's concurrency limit. That bug
   is fixed; if "Concurrent session limit reached" still shows up
   frequently after this fix, it's genuinely fal-side, not this app. As of
   2026-09-14 this error is never auto-retried (see #4) — it surfaces
   immediately via `describeError()` and the session hard-stops.

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

7a. **Miko Lite (`decart/lucy2-vton/realtime`) does not perform a full
   character swap — informally confirmed live, 2026-09-14.** This answers
   (but does not replace) the formal side-by-side comparison `FIX_PLAN.md`
   §6.7 asks for and had marked `[LIVE — ask owner]`, still unresolved: a
   real Full-character-swap session on Lite connected and billed normally,
   but produced no visible swap. `FIX_PLAN.md` §6 had already flagged this
   as an explicit risk before it was ever tested ("fal says its reference
   is used 'as a character reference', but a full swap is **unproven**").
   Lite is fal's virtual-try-on model; in practice it appears to only
   actually apply outfit/garment edits, regardless of what the prompt asks
   for. Per §6.4's standing owner decision, the Lite+character combination
   stays available and unwarned unless the owner asks otherwise — this
   entry exists so a future session doesn't have to rediscover the same
   negative result by spending real money again. **Not yet run: the actual
   §6.7 A/B (15s each, same reference/lighting, verdict recorded here)** —
   this was one real user session, not that structured comparison.

8. **Every Start runs a free network check first** (`lib/network-check.js`,
   main process only, IPC `net:check`). It opens nothing billable: a DNS
   lookup, three TCP connects to `fal.run:443` and local route/VPN queries.
   - macOS: `route -n get <ip>` for the interface fal traffic uses, plus
     `scutil --nc list` for connected VPN services. The 10 or so `utun`
     interfaces macOS creates itself have only link-local addresses, so a
     tunnel counts as a VPN only when it carries fal's route or has a
     routable address.
   - Windows: the interface comes from the test connection itself. Its
     local address belongs to exactly one entry in `os.networkInterfaces()`
     (`interfaceForAddress`), so no shell is needed. PowerShell
     (`Get-NetAdapter`, `Get-VpnConnection`, 8 s limit, nothing from the
     network put in the command) only adds adapter descriptions and
     connected built-in VPNs. Names and descriptions are matched against
     known VPN clients; Hyper-V/WSL adapters don't count. The first version
     relied on one `Find-NetRoute` PowerShell call with a 4 s limit and came
     back empty on the CI Windows runner. CI's Windows job now runs the
     real check (`MIKO_REAL_NETWORK_CHECK=1`) and fails if no interface is
     found or PowerShell lists no adapters. Not yet tried on a real PC.
   - A proxy comes from Electron's `resolveProxy` for the fal URL.
   - Offline or unreachable **blocks** Start (no "Start anyway"). A VPN, a
     proxy or a slow link (>400 ms typical connect) **warns** with "Check
     again", "Start anyway" and "Cancel". "Start anyway" is remembered
     until the signature (issue kinds, VPN name, proxy, route interface)
     changes. If the check itself fails, Start goes ahead.
   - After Start, the WebRTC video link has `WEBRTC_CONNECT_TIMEOUT_MS`
     (2s, `lib/lucy-config.ts`) to actually come up before the session
     hard-stops. This is a real billing cap, not just a UX timeout — fal's
     session (and billing) starts the moment its server accepts the
     signaling connection, not when video reaches the client. The error
     message is picked from real evidence, never a guess: a blind timeout
     names no cause (could be local network, a VPN/firewall, or fal.ai
     itself being slow); an actual ICE/peer-connection failure — one that
     actually negotiated and then broke — is the only case confident
     enough to name a firewall/VPN/restrictive network specifically. See
     `describeError()` in `lucy-realtime-session.ts`.
   It only detects and advises — see the rejected features below.

9. **Two real output-quality bugs found against fal/Decart's own published
   prompting docs (`docs.platform.decart.ai/models/realtime/lucy-2.5-prompting`,
   fetched 2026-09-14) — both were shipping backwards from the vendor's own
   recommendation, likely the direct cause of "inconsistent/morphing" swap
   complaints:**
   - **Prompt expansion defaulted to OFF.** Decart's docs state it verbatim:
     "It is on by default; keep it on" — it rewrites the raw instruction to
     fit each frame/reference, which is what keeps a swap temporally stable
     instead of flickering/morphing frame to frame. Miko's own default was
     the opposite (`Boolean(undefined)` = `false` in `main.js`'s
     `sanitizeSettings`, unchecked checkbox in `index.html`). Fixed: an
     absent field now defaults to `true`; an explicit user choice (on or
     off) is still respected either way. If a user has an existing saved
     settings file with this field explicitly `false` from before this fix,
     their choice is preserved — only a genuinely absent field changed.
   - **Reference images were capped at 1024px, below Decart's own
     recommendation.** Their reference-image guidance: "maintain sharp
     quality at ~1280px longest side." `lib/reference-policy.js`'s
     `computeReferenceSize()` was needlessly downscaling sharper uploads to
     1024px. Cap raised to 1280px; `PREFERRED_REFERENCE_IMAGE_DIMENSION` in
     `lib/lucy-config.ts` updated to match; the in-app fidelity hint text
     updated from "768–1024px" to "768–1280px".
   Decart's docs also specify a **~750-character / ~120-word prompt limit**
   (longer triggers an error) and prompt-writing rules (concrete nouns over
   pronouns, one focused edit per prompt, avoid filler adjectives like
   "realistic"/"seamless"/"natural"/"cinematic") — `DEFAULT_PROMPTS` in
   `lib/session-presets.js` was checked against these and already complies;
   no change made there. If output quality complaints continue after the
   two fixes above, re-check the *current* prompt text (if the user edited
   it) against these rules before assuming a code bug.

10. **Capture was square (1:1) — Lucy 2.5's native resolution is 16:9
    landscape, not square. Fixed 2026-09-14.** Verified directly against
    fal/Decart's model spec page
    (`docs.platform.decart.ai/models/realtime/lucy-2.5`, fetched
    2026-09-14): "Resolution: 1280×720", landscape (16:9) or portrait
    (9:16) only — "the documentation makes no mention of 1:1 aspect ratio
    support." Miko was forcing `aspectRatio: 1` (1024×1024 / 768×768 /
    512×512) on every capture in `acquireLocalStream()` and
    `stepResolution()` — feeding the model a shape it was never documented
    to accept, which it then has to crop/pad/resize internally. This is a
    stronger, independently-verified candidate for "inconsistent/morphing"
    output than either fact #9 fix, found while investigating the same
    complaint.

    Fixed: `RESOLUTION_STEPS` in `lib/lucy-config.ts` changed from
    `[1024, 768, 512]` (square) to `[1280, 960, 640]` (16:9 landscape
    widths — height is always derived as `width * 9/16` at every
    `getUserMedia`/`applyConstraints` call site, never stored separately).
    1280 is Decart's actual documented native width; 960/640 are
    lower-fidelity fallback steps for the existing poor-network adaptive
    stepping mechanism (`stepResolution()`), not independently confirmed by
    Decart's docs as supported alternate input sizes — if quality
    complaints ever center specifically on the *degraded* (non-1280) steps,
    that's the first thing to question, not the 1280 native case.
    `index.html`'s `#resolutionSelect` options and `#resolutionFact`
    default text, and `main.js`'s `sanitizeSettings` whitelist, updated to
    match (a legacy 512/768/1024 saved value now falls back to 1280).

11. **The OBS relay's auth token was regenerated on every launch — any URL
    saved into an OBS Browser Source went stale (401 Unauthorized) the next
    time Miko started. Fixed 2026-09-14.** Found while setting up a real
    OBS scene: two Browser Sources already existed pointing at
    `http://127.0.0.1:5590/?token=...` from an earlier session, both
    already correctly sized 1280×720, but both 401'd — the token they held
    belonged to a process that no longer existed. `startObsServer()` used
    to call `randomBytes(24)` fresh every time `obsServer` was null (i.e.
    every app launch). Fixed: `loadOrCreateObsToken()` persists the token to
    `<userData>/obs-token.txt` (plain text — this only guards the local
    relay from other localhost processes/browser tabs reading the feed,
    it's not a credential like the fal key, doesn't need `safeStorage`) and
    reuses it on every subsequent launch. A Browser Source's URL in OBS can
    now genuinely be configured once and left alone. If "OBS shows nothing"
    or a 401 comes up again, check whether `obs-token.txt` still exists and
    matches what's actually saved in OBS's scene collection JSON
    (`%APPDATA%\obs-studio\basic\scenes\*.json`, `sources[].settings.url`)
    before assuming a code regression — deleting/moving userData, or a
    manually-edited OBS URL, would still cause exactly this symptom.

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
