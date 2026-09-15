# Miko — Agent Guide (Claude Code / Codex / any AI coding assistant)

This file is the fast-start briefing for an AI assistant picking up this
project cold. Read this before touching code. `README.md` has the
user-facing overview; `PRODUCT.md` has the UI/product rationale. This file
is the "what will bite you" doc.

**Active work: `FIX_PLAN.md`** — the full fix plan from the 2026-09-14
review (billing safety, making the swap actually swap, shippable installers,
robustness, tests). Follow its ground rules, above all: **no live fal.ai
sessions without the owner's explicit OK**, since every connect attempt bills
the owner's real account.

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
fal.ai/dashboard/keys). Enter it in the app's Model settings → API key —
it's encrypted at rest via Electron's `safeStorage` (OS keychain) in the
app's userData directory, never committed to this repo. For scripted/CI
use you can set `FAL_KEY` as an env var instead; `main.js`'s `loadFalKey()`
checks that first.

Check account balance at fal.ai/dashboard/billing — the app also surfaces
it in-app, masked behind an eye toggle by default.

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
   - [Node.js](https://nodejs.org) 22 LTS or newer — installs `npm`
     alongside it. Node 22 is needed for `npm test` on Windows: its test
     runner expands `test/*.test.js` itself, which Command Prompt doesn't.
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
   You'll still need a fal.ai API key entered in Model settings → API key
   (or set the `FAL_KEY` environment variable) before Start Live will
   connect — see "Install & run" above.
7. **To check it on this machine** (optional): `npm test` runs everything,
   including the Windows network detection and the OBS page in a real
   browser when these are set:
   ```
   set MIKO_REAL_NETWORK_CHECK=1
   set MIKO_BROWSER=C:\Program Files\Google\Chrome\Application\chrome.exe
   npm test
   ```
8. **OBS:** follow "OBS output setup" in `README.md`. On Windows the OBS
   page file is `%APPDATA%\Miko\obs-output.html`.

## Architecture (see README.md for the diagram)

- `main.js` — Electron main process: fal.ai key storage (`safeStorage`),
  balance lookup, realtime token minting, local OBS output (`lib/obs-relay.js`). No
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
     connected built-in VPNs. Its answer is cached: asked at launch, reused
     for 5 minutes, and asked again at once when the connection uses an
     adapter it doesn't list (a VPN that just came up), so a slow
     PowerShell (over 8 s on a busy CI runner) doesn't hold up Start. Names and descriptions are matched against
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
     (10 s, `lib/lucy-config.ts`) to actually come up before the session
     hard-stops. The clock starts before the token request, so it covers
     the whole handshake. It was 2 s for a few hours on 2026-09-14 and every
     real Start timed out. Each attempt logs one line with per-step times
     ("Connected in 3.1s — token 0.4s · service ready 1.2s · …" or "Connect
     failed after 10.0s — … · waiting on: answer (…)"); tune from those.
     This is a real billing cap, not just a UX timeout — fal's
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

11. **OBS output is a local page OBS's Browser Source loads, at the fixed
    URL `http://127.0.0.1:7893/`** (no token, an owner decision on
    2026-09-14; commit c13d7b7 has the token version). `lib/obs-relay.js`
    serves the page (`/`), its script (`/page.js`, so the CSP can keep
    `script-src 'self'`) and the frame stream (`/stream`, multipart PNG;
    `/stream.mjpeg` is an alias).
    - The page draws onto a canvas with `object-fit: contain`, the same
      approach as the sibling Swapy project: black bars, never cropped or
      stretched. Its CSP must allow `style-src 'unsafe-inline'`, or the
      browser drops the `<style>` block and the frame renders tiny in the
      top-left corner.
    - The first version was a bare `<img src="/stream.mjpeg">`. When the
      stream ended (Miko restart, OBS output toggled, a crash), Chromium
      kept the last frame and never reconnected, so OBS froze or went
      blank until someone refreshed the source by hand. The page script
      now goes black when the stream ends and reconnects every second. It
      can't help if OBS started while Miko wasn't running: the page itself
      never loaded, so refresh the source once.
    - Pacing: at most one frame in flight per viewer. A viewer still
      receiving an older frame skips ahead and gets the newest one when its
      socket drains, including the black end-of-call frame, so OBS never
      falls behind or freezes on a face. The page likewise decodes only the
      newest frame. Before this, a slow Browser Source made frames queue
      in the main process and OBS lag further and further behind.
    - `startObsFrameLoop()` in `app.js` starts the next encode only after
      the previous frame has reached the main process, and drops a frame
      still encoding when the call ends.
    - OBS page file: at every launch Miko writes `obs-output.html` (from
      `loaderHtml()`) to its userData folder, for a Browser Source in
      "Local file" mode. A local file loads even while Miko is closed,
      which is the point: a URL source that failed to load (OBS opened
      before Miko) never retries. The file keeps an iframe on Miko's page,
      hidden until the page's origin-checked `obs-alive` heartbeat arrives,
      and searches 7893–7902 again (the usual port every other try) when
      heartbeats stop or the stream has been down for 5 s.
    - Send to OBS is on by default (`obsEnabled` absent → true), starts at
      launch, and is saved the moment it's flipped
      (`settings:set-obs-enabled`). The log says when OBS connects and
      disconnects.
    - Windows runs the same code. `startPreferred()` tries 7893, then up
      to 7902: Hyper-V, WSL or Docker can reserve blocks of ports
      (`netsh interface ipv4 show excludedportrange protocol=tcp`), which
      fails with EACCES rather than EADDRINUSE. The app says when it had to
      move, and the panel shows the URL in use. CI's Windows job loads the
      page in the runner's Chrome (`test/obs-page.e2e.test.js`, enabled by
      `MIKO_BROWSER`), plus the relay unit tests.
    - If OBS shows nothing, check the source's URL in OBS's scene JSON
      (`~/Library/Application Support/obs-studio/basic/scenes/*.json` or
      `%APPDATA%\obs-studio\basic\scenes\*.json`, `sources[].settings.url`).
      Sources set up before 2026-09-14 point at the old
      `http://127.0.0.1:5590/?token=…`. Also check the source's width and
      height: OBS's default Browser Source is 800×600, which downscales.

12. **Decart direct is a second key supplier (2026-09-15), fully separate
    from fal.** Plan and sources: `DECART_PLAN.md`.
    - `lib/decart-realtime-session.ts` (`DecartRealtimeSession`) has the
      same surface app.js uses on the fal session. It's bundled on its own
      (`lib/decart-entry.ts` → `dist/decart-session.bundle.js`, about 1 MB
      with `@decartai/sdk` 0.2.0 and `livekit-client`) and loaded by app.js
      only when Decart is the supplier. The fal bundle must stay
      byte-identical: compare its hash before and after touching anything
      shared.
    - Keys: `decart-key.store` (safeStorage), never in the renderer. The
      renderer gets a client token from `decart:get-token`
      (`lib/decart-api.js`): 60 s, `allowedModels: [model]`,
      `constraints.realtime.maxSessionDuration: 600`. REST uses
      `x-api-key`; the realtime WebSocket carries the token as `api_key`.
    - Models: Miko Pro → `lucy-2.5`, Miko Lite → `lucy-vton-3.5`, both
      1280×720 at 30 fps, $0.02/s. Never the `-latest` aliases
      (`lucy-latest` is 1088×624).
    - The SDK retries and reconnects by itself, and that can't be turned
      off. The session stops at the first `reconnecting` or `error`;
      disposing the SDK session ends its retries. Two limits: 10 s from the
      token request to "connected", then 30 s for the first frame. The
      service prepares the model after connecting (about 6–7 s seen), and
      Decart bills only active generation, so that second wait is free. The
      SDK calls `onRemoteStream` again for every output track, audio first
      in practice: Miko shows only the newest video track, video-only. `telemetry: false` is passed. The SDK's
      frame-timing worker can't be created in an IIFE bundle, so the SDK
      turns frame timing off.
    - No balance API: Start is gated on a daily spend limit (setting
      `decartDailyLimit`, default $5, `DailySpend` in billing-policy.js)
      and `GET /v1/realtime/quota`. Decart spend never touches fal's
      `BillingMeter`.
    - The CSP adds `api.decart.ai`, `api3.decart.ai`, `lk.decart.ai` and
      `*.lkc.decart.ai`. The network check probes `api3.decart.ai` for
      Decart.
    - Not yet run against the live service (needs the owner's Decart key
      and OK): `DECART_PLAN.md` L1–L6.

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
  local HTTP page (`lib/obs-relay.js`, see fact 11) that OBS's built-in
  Browser Source loads directly. Keep it that way.

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
