# Miko — Fix Plan (review of 2026-09-14)

**Executor:** Codex (or any coding agent). **Reviewer/author:** Claude.
**Owner:** TifeDiceeyy — the only person who can answer the ⛔ decisions and
approve anything marked **[LIVE — ask owner]**.

Read `AGENTS.md` first — it holds the fal.ai protocol facts this plan relies
on. Line numbers below are as of commit `13f9508`; they will shift as you
edit. **Function names are authoritative, line numbers are hints.**

---

## Status (updated 2026-09-14)

- **Done and committed:**
  - Phases 1–5, by Codex (`200f539`).
  - Phase 6 Model + Task picker, the exact SDK pin, the session-end reason
    and cost line (4.4 / 6.5), and the billing guard now stopping after an
    error, by Claude (`aef8df7`).
  - A one-session-at-a-time guarantee against three fal SDK 1.10.1 bugs
    (delayed sends re-opening closed connections, sockets surviving
    `close()` mid-handshake, token-refresh loops after failed connects), by
    Claude (`d527fac`). See `AGENTS.md` fact 7. In the live check the owner
    approved, Stop mid-handshake three times left 0 sockets and 0 `fal.run`
    connections.
  - 33 tests pass. Typecheck, syntax checks and in-app checks pass.
- **Release:** **v1.1.0 is the latest**, published 2026-09-14 with the
  owner's OK: https://github.com/TifeDiceeyy/Miko/releases/tag/v1.1.0,
  built from `4fe4707`. It adds the pre-connect network check. Checked:
  - The Mac app inside the DMG and the zip is ad-hoc signed with the
    camera permission, version 1.1.0, ID `com.tifediceeyy.miko`.
  - The Windows app packed into the installer has the new check.
  - CI passed on that commit, including the real check on a Windows
    runner.
  - The uploaded files match `SHA256SUMS.txt`.
  - v1.0.2 (`b490ff8`) was removed with its tag on 2026-09-14 at the
    owner's request. It had 0 downloads. v1.1.0 is now the only published
    release.
  - v1.0.1 (`2be3cc0`), which predates the socket guard, was removed with
    its tag on 2026-09-14 at the owner's request. It had 0 downloads.
  - Codex deleted v1.0.0, which had the phantom-billing bug, on 2026-09-14.
- **Mac build recipe that works** (Developer ID signing stalls waiting for
  Keychain access):
  1. `CSC_IDENTITY_AUTO_DISCOVERY=false npx electron-builder --mac --universal`
  2. `codesign --deep --force --options runtime --entitlements entitlements.mac.plist --sign - release/mac-universal/Miko.app`
  3. `CSC_IDENTITY_AUTO_DISCOVERY=false npx electron-builder --prepackaged release/mac-universal/Miko.app --mac dmg --universal`
     (point at the `.app`: electron-builder 26's dmgbuild copies the folder
     you give it, so `release/mac-universal` ships `Miko.app/Miko.app`).
  4. `ditto -c -k --sequesterRsrc --keepParent release/mac-universal/Miko.app release/Miko-<version>-mac-universal.zip`
     (electron-builder's zip target would nest the app inside a
     `mac-universal/` folder).

  Skip step 2 and the app ships **unsigned, without the camera
  permission**. Check with `codesign --verify --deep --strict` on the app
  inside the DMG and inside the zip.
- **Production-readiness review (2026-09-14), "important" items done:**
  - Balance fallback: Start uses the last balance reading from within 15
    minutes if the billing service is unreachable.
  - Crash and error logging, with a one-time window reload after a crash.
  - A navigation guard, so the window can't be replaced by another page.
  - The CSP only allows fal's realtime host.
  - electron-builder 26.15.3.
  - An app icon.
  - The rename to Miko. Settings migrate; the saved key has to be
    re-entered once.
  - An MIT LICENSE.
  - CI: tests on Ubuntu, and the Windows installer built on Windows.
- **Pre-connect network check (v1.1.0):** every Start first checks for a
  VPN, a proxy, an unreachable service or a slow link, on macOS and
  Windows, and says what to turn off. Offline blocks; the rest warn with
  "Start anyway". Two video-link failures in a row stop retrying and name
  the likely VPN or firewall. See `AGENTS.md` fact 8. 47 tests pass
  locally (the real-network test is opt-in); CI's Windows job runs all 48,
  including the real check.
- **Still open:**
  - Electron 38 is out of support (only 42–44 are supported) and has two
    high audit findings. Upgrade to Electron 44.
  - Mac signing (D2): builds are ad-hoc and not notarized.
  - No automatic updates yet.
  - The Windows installer has never been run on Windows.
  - Request-payload deletion is unverified. fal needs an admin key for it,
    and a 404 is logged as "Deleted".
  - Live tests 1.7 and 6.7: they bill, so they need the owner's OK. The
    owner skipped 6.7 for now on 2026-09-14.

---

## Ground rules

1. **No live fal.ai sessions without the owner's explicit OK — every time.**
   Every connect attempt bills the owner's real account ($0.04/s in
   Character Swap, $0.02/s in Virtual Try-on, and even
   sub-second failed attempts show up as billed rows on the fal dashboard).
   Verify with the unit tests (Phase 5) and with CDP UI checks that don't
   connect (see "Testing without a human" in `AGENTS.md`). Steps that truly
   need a live session are marked **[LIVE — ask owner]**.
2. **Precise errors only.** Every failure shows its real cause, never a
   generic placeholder (standing owner rule — `AGENTS.md` fact #6).
3. **UI text says "Miko" only** (see decision D4 for fal links).
4. Never reintroduce session recording. Never auto-kill other processes.
5. After every step: `npm run typecheck && npm run check && npm run build`
   (plus `npm test` once Phase 5 exists).
6. One commit per step, descriptive message, **no `Co-Authored-By` trailer**
   (owner preference).
7. Don't push, publish, or delete GitHub releases without the owner's OK.
8. `lib/*.ts` must stay browser-bundlable by esbuild (no Node APIs). Inject
   anything environment-specific (storage, timers, clock) so it's testable.

---

## Owner decisions

| ID | Decision | Recommendation | Blocks |
|----|----------|----------------|--------|
| D1 | Unpublish GitHub Release v1.0.0 (0 downloads, contains the phantom-billing bug)? | Yes — convert to draft now: `gh release edit v1.0.0 -R TifeDiceeyy/Miko --draft` | Phase 0 |
| D2 | macOS signing: (A) Apple Developer ID + notarization ($99/yr), or (B) ad-hoc build + documented quarantine-removal step? | B now, A before sharing widely | 3.3 |
| D3 | Hard-require a reference image in both modes, or also allow prompt-only effects? | Hard-require (every accidental start costs money) | 2.1 |
| D4 | "fal" in UI text: users must visit fal.ai for keys/top-ups | No "fal" in visible text; buttons "Get a key" / "Top up balance" open the fal URLs; raw provider errors rewritten | 4.5 |
| D5 | Rename app identity (`name`/`appId`) to Miko? | Yes, now, before real users — saved key must be re-entered once | 3.5 |
| D6 | Disconnect on screen lock too (not just sleep)? | Yes | 4.2 |

---

## Phase 0 — pull the stale release ⛔ D1

**Why:** `gh release list` shows `v1.0.0` published and marked *Latest*.
Extracting both installers' `app.asar` shows `dist/lucy-session.bundle.js`
still contains `lucy-realtime-singleton` (the fixed `connectionKey` behind
phantom billed sessions), and `app.js` has no balance floor, guard or timer.
Both were built Sep 13 14:06–14:11, before commits `e360cca`, `65acce9` and
`13f9508`.

**Do:** after owner OK, `gh release edit v1.0.0 -R TifeDiceeyy/Miko --draft`.
It gets replaced by v1.0.1 in step 3.6.

---

## Phase 1 — billing safety

### 1.1 One start gate for every connect path
**Why:** Start is gated (`app.js` Start click handler, ~686-699), but
"Try again" (`app.js` ~704, `session.connect()`) and auto-reconnect
(`lucy-realtime-session.ts` `scheduleReconnect`, ~760, `this.connect(true)`)
connect with no balance check.

**Do:**
- `LucyRealtimeSession.setAttemptGuard(guard: () => Promise<string | null>)`.
  The guard returns `null` to allow, or a precise, user-facing reason to block.
- In `connect()`: after the single-flight checks and after
  `setSnapshot({ state: "connecting" })` (so Start disables immediately),
  `const block = await this.attemptGuard?.()`. Then re-check
  `attempt !== this.attemptGeneration || this.closedIntentionally` (return
  silently if so). If `block` is set: `teardown({ keepIntentionalFlag: true,
  keepLocalStream: true })`, `setSnapshot({ state: "error", error: block,
  remoteStream: null })`, and **do not** call `scheduleReconnect`. The existing
  `finally` must still reset `connecting`.
- `app.js`: `attachSession()` installs the guard (`checkCanStart`, see 1.2 and
  2.1). The Start handler and "Try again" both just call `session.connect()`.
  Remove the inline balance check from the Start handler.

**Done when:** tests T3 and T4 pass.

### 1.2 Calculate the seconds locally (billing meter)
**Why:** the current guard (`startLiveBalanceGuard`, `app.js` ~591) polls
fal's balance every 10s. All evidence so far says fal posts a realtime charge
**when the request ends** (one dashboard row per session with a final
duration; the owner's balance only dropped after the call ended). If so, the
guard sees the pre-call balance for the whole call and never trips. The owner
also explicitly asked for "the seconds to be calculated". (Step 1.7 confirms
posting behavior; this design is safe either way.)

**Do:**
- New `lib/billing-meter.ts` (pure, exported through `lib/renderer-entry.ts`):
  - `MIN_BALANCE_USD = 1.0`.
  - `PRICE_PER_SECOND_USD` keyed by endpoint: `decart/lucy-2-5/realtime` →
    `0.04`; `decart/lucy2-vton/realtime` → `0.02`. Both checked on fal's own
    model pages on 2026-09-14 ("Your request will cost $0.04 per second" /
    "$0.02 per second"). An earlier `0.02` for Lucy 2.5 came from a
    third-party search summary and was wrong. At $0.04/s the $1.00 floor is
    about 25 s of runway, not 50 s.
  - `class BillingMeter` with `observeBalance(usd)`, `recordSpend(seconds,
    endpoint)`, `effectiveBalance()`, `remainingSeconds(endpoint)` =
    `floor((effectiveBalance − MIN_BALANCE_USD) / price)`, never negative.
  - Reconciliation: keep `trusted` (last polled balance) and `unposted`
    (local spend since `trusted`). On a new poll `P`: if
    `P < trusted − 0.005` then `drop = trusted − P`,
    `unposted = max(0, unposted − drop)`, `trusted = P`; otherwise keep both.
    `effective = trusted − unposted`. This can briefly double-count, which
    errs toward safety, and never under-counts.
  - Persist `{ trusted, unposted, savedAt }` through an injected storage
    (`localStorage` in the app). Ignore anything older than 15 min; that
    covers restarting the app right after a call, before fal posts the charge.
- `app.js`:
  - `checkCanStart()`: refresh the balance, then `meter.observeBalance`. If the
    balance is unknown, allow (unchanged behavior — a genuinely empty account
    still fails fast with the precise token error). If
    `remainingSeconds(mode) <= 0`, block with e.g. "Estimated balance $1.04 is
    at the $1.00 minimum — top up to start a session."
  - Count billed time in **every** active state (`connecting`, `live`,
    `reconnecting`) — fal bills the signaling/connecting phase too. Measure
    with `Date.now()` deltas, **not tick counts** (see gap 24: timers get
    throttled in a minimized window).
  - Every tick: if `remainingSeconds(mode) <= 0`, run `clearTransientSessionMedia`
    and `session.disconnect()` with "Auto-disconnected: estimated balance
    reached the $1.00 floor (est. $X.XX)".
  - Keep polling every 10s, but only to feed `observeBalance`, and keep it
    running through `reconnecting` (today `render()` stops it on any exit from
    `live`, ~250-251).
  - Timer chip: `mm:ss · mm:ss left`.
  - Balance display shows the effective balance, labeled "est." while
    `unposted > 0`.

**Done when:** T7–T10 pass.

### 1.3 Replace the ICE restart with a grace period
**Why:** `handleConnectionTrouble` (~697-730) does an ICE restart and
returns. Nothing ever sets the state back to `live` — the only place that
does is `connect()` (~226). Result: the UI is stuck on "Reconnecting…", Start
stays disabled, and the timer and balance guard stop, while media may keep
flowing and billing. Also, per `AGENTS.md` the server answers exactly one
offer per session; nobody has verified it accepts a second (restart) offer.

**Do:**
- Delete the ICE-restart branch and the `iceRestartTried` field.
- `oniceconnectionstatechange`:
  - `disconnected` → start a 4000 ms grace timer (if not already running).
  - `connected` / `completed` → cancel the timer.
  - `failed` → cancel the timer, then call `handleConnectionTrouble` immediately.
- When the grace timer fires → `handleConnectionTrouble("ICE connection
  disconnected for 4s")`, which leads to `scheduleReconnect`.
- Clear the grace timer in `teardown()`. During the grace period the state
  stays `live`.

**Done when:** T5 and T6 pass.

### 1.4 A token-refresh blip must not kill a live call
**Why:** the `tokenProvider` wrapper in `open()` (~469-486) calls
`handleSignalingError` whenever a refresh fails while live, which means
teardown plus a reconnect (a new billed session). The token only matters
when the socket opens, and the SDK already retries refreshes itself.

**Do:** in the wrapper's "no pending connect" branch: if
`isUnrecoverableAccountError(error)`, call `handleSignalingError` (terminal,
as now). Otherwise `console.warn` plus a log line (4.7), and leave the
session alone. Always re-throw.

**Done when:** T11 and T12 pass.

### 1.5 Poor network: degrade, never reconnect; fix the meter math
**Why:** `pollStats` (~816-876) reconnects after 4 poor polls — a new billed
session that won't fix the user's network. Loss % is computed from
**cumulative** counters since the session started (`lastStats` is stored but
never used), so the network meter shows the session average, not current
conditions. `stepResolution` (~889-914) opens a **second** `getUserMedia` on
the same camera, which fails with `NotReadableError` on many Windows drivers.

**Do:**
- Keep the previous cumulative `packetsSent` / `packetsLost` and compute
  `loss% = Δlost / (Δsent + Δlost)` (0 when the denominator is 0). RTT = the
  latest `roundTripTime`.
- Remove the `handleConnectionTrouble` call from the poor streak. Keep the
  resolution step-down, plus a persistent "weak network" hint.
- `stepResolution`: `track.applyConstraints({ width: { ideal: r }, height:
  { ideal: r } })` on the **existing** video track. On failure keep the
  current resolution and show a transient warning — no teardown.

**Done when:** T13 and T14 pass.

### 1.6 Remove superseded code
Delete `startLiveBalanceGuard` / `stopLiveBalanceGuard` (replaced by 1.2).

### 1.7 [LIVE — ask owner] Confirm when fal posts charges
Temporarily poll the balance every 5s (local debug change, not committed),
run a 60s session with a reference image, then keep polling for 3 min after
Stop. Log timestamp + balance each time. Record whether the balance drops
during the call, at the end, or minutes later, and add the answer to
`AGENTS.md` "Hard-won facts". The meter works either way; this just
documents it.

---

## Phase 2 — make the swap actually swap

### 2.1 Require a reference image ⛔ D3
`checkCanStart()` blocks with "Choose a reference image before starting —
Character Swap needs a photo of the person or character" (Virtual Try-on:
"…a photo of the garment"). Show the same text as the Start button tooltip.
**Why:** today Start works with no reference. It bills, but no swap is
possible, and the default prompt literally refers to "the reference image".
This is the most likely cause of "prompts not hitting".

### 2.2 Downscale the reference once
**Why:** `readFileAsDataUri` (`app.js` ~288) sends the original file — a
phone photo is 5–10 MB as a data URI.

**Do:** run the minimum-size check on the original first (short edge ≥ 512,
fal's documented minimum). Add a pure helper `computeReferenceSize(w, h)`:
`scale = min(1, 1024 / longEdge)`, but if `shortEdge × scale < 512` use
`scale = 512 / shortEdge`. Draw onto a canvas filled `#fff` first (so
transparent PNGs don't turn black), then `toDataURL("image/jpeg", 0.9)`.
Add `W×H, N KB` to the activity log. Keep the "768+ gives better fidelity"
hint based on the original size.

**Done when:** T15 passes; a 12 MP photo produces a data URI under 400 KB.

### 2.3 Wait for typing to stop before sending the prompt
**Why:** `updateEditParams` (~186-191) re-sends the whole state, reference
image included, on every keystroke while live (the SDK throttles to about
8/s).

**Do:** while live, prompt-only changes wait 600 ms after the last keystroke
before sending. Reference or prompt-expansion changes send immediately (and
cancel any pending prompt send). **Always send the full state**, never
partial updates — a partial message might clear the reference server-side
(unverified, so stay defensive). On send, log "Prompt updated".

**Done when:** T16 passes.

### 2.4 A default prompt per mode
Move `DEFAULT_PROMPT` in `main.js` to `DEFAULT_PROMPTS` keyed by endpoint.
Virtual Try-on default: "Dress the person in the live camera feed in the
exact garment shown in the reference image, matching its color, material,
pattern, fit, and details. Keep the person's face, identity, pose, body
shape, and background unchanged." When the user switches mode and the prompt
still equals the other mode's default (never edited), swap it for the new
mode's default.

---

## Phase 3 — installers that actually ship

### 3.1 Camera entitlement (macOS)
**Why:** `codesign -dv` shows hardened runtime on (`flags=adhoc,runtime`),
but `codesign -d --entitlements -` lists only `allow-jit`,
`allow-unsigned-executable-memory` and `disable-library-validation` — no
`com.apple.security.device.camera`. macOS blocks the camera for hardened apps
without it. (High confidence; not launch-tested.)

**Do:** add `build/entitlements.mac.plist` with those three plus
`com.apple.security.device.camera`. In `package.json` `build.mac` set
`"hardenedRuntime": true`, `"entitlements"`, `"entitlementsInherit"` (both
pointing to the plist) and `"gatekeeperAssess": false`.

**Done when:** `codesign -d --entitlements - release/mac-universal/Miko.app`
lists `com.apple.security.device.camera`.

### 3.2 macOS camera-permission messages
Add a `main.js` IPC `media:camera-access` that returns
`systemPreferences.getMediaAccessStatus("camera")` on darwin. If it's
`denied` or `restricted`, show: "macOS is blocking camera access for Miko.
Open System Settings → Privacy & Security → Camera, turn Miko on, then click
Try again." Add a button that opens
`x-apple.systempreferences:com.apple.preference.security?Privacy_Camera`
through its **own** IPC. Don't loosen the `https://`-only check in
`shell:open-external`.

### 3.3 Signing ⛔ D2
- **A:** `build.mac.notarize` using the `APPLE_ID` /
  `APPLE_APP_SPECIFIC_PASSWORD` / `APPLE_TEAM_ID` environment variables, plus
  a Developer ID identity.
- **B:** README/AGENTS instructions for
  `xattr -dr com.apple.quarantine /Applications/Miko.app`.

Windows stays unsigned (the SmartScreen note is already documented).

### 3.4 Build scripts and the wrong Windows instructions
**Why:** `AGENTS.md` "Building on Windows itself, after cloning" step 4 says
to run `npx electron-builder --win nsis --x64` directly. `dist/` is
gitignored and electron-builder doesn't run `npm run build`, so on a fresh
clone the installer ships without `dist/lucy-session.bundle.js` and crashes
at `app.js:5` (`window.LucySession` is undefined). The current installers
only work because they were built with `npm run dist` on this machine.

**Do:** add `"dist:mac": "npm run build && electron-builder --mac --universal"`
and `"dist:win": "npm run build && electron-builder --win nsis --x64"`, and
update `AGENTS.md` and `README.md` to use them.

### 3.5 Rename the app identity ⛔ D5
Set `package.json` `name` to `miko` and `build.appId` to e.g.
`com.tifediceeyy.miko`. The userData folder and the safeStorage identity will
change, so the saved key won't decrypt. `loadFalKey` already reports that
precisely ("could not be decrypted … re-enter"). Optionally migrate
`settings.json` only (never the key). Confirm the result with
`app.getPath("userData")` in both dev and the packaged app.

### 3.6 v1.0.1: rebuild, verify, release
- Bump `package.json` to `1.0.1`, then run `npm run dist:mac` and `npm run dist:win`.
- Extract each `app.asar`
  (`node node_modules/@electron/asar/bin/asar.js extract <asar> <dir>`) and
  grep the **extracted** files. Grepping the `.asar` file itself silently
  returns 0 on macOS. Expect `lucy-realtime-singleton` to be absent and
  `BillingMeter` / `setAttemptGuard` to be present.
- Mac: launch the packaged app and confirm the camera permission prompt and
  preview appear. **[LIVE — ask owner]** one connect.
- Windows: install on the owner's Windows PC, check the preview, then
  **[LIVE — ask owner]** one connect.
- After owner OK: `gh release create v1.0.1` with the dmg, zip, exe and
  `SHA256SUMS.txt`, and remove the v1.0.0 assets (D1).

---

## Phase 4 — robustness and polish

- **4.1 Single-instance lock.** In `main.js` before `whenReady`, call
  `app.requestSingleInstanceLock()`. If it returns false, quit; otherwise
  focus the existing window on `second-instance`. Two instances today mean
  two sessions, double billing and an OBS port clash.
- **4.2 Sleep/lock ⛔ D6.** After app ready, listen for `powerMonitor`
  `suspend` (plus `lock-screen` per D6) and send
  `webContents.send("system:suspend", reason)`. Expose `onSystemSuspend(cb)`
  in the preload. `app.js` disconnects any active session with a precise
  activity line ("Disconnected: computer went to sleep").
- **4.3 Mode switch leaks the camera.** `getLucySession` calls
  `disconnect()`, which keeps the camera stream, on the session it then
  throws away. The camera light stays on and the new session has no
  preview. Use `hardStop()` there, and call `void session.previewCamera()` at
  the end of `attachSession()`.
- **4.4 Activity log wipes errors.** In `render()` (~243-259) the transition
  block logs "Error: …", then `clearTransientSessionMedia()` immediately
  `replaceChildren()`s the log. The same happens to "Auto-disconnected…".
  Change it to `clearTransientSessionMedia(endReason)`: wipe the log, then
  append one line with why the session ended (error text, auto-disconnect,
  sleep, "Stopped by you"). That keeps the privacy intent — no per-call
  timeline — while the reason stays visible.
- **4.5 "fal" wording ⛔ D4.** Remove "fal" from visible strings: the
  tooltip and toasts added in `13f9508` ("top up at fal.ai/dashboard/billing"),
  and `main.js` "Could not reach fal.ai…" and "fal token request failed…".
  Parse the token error body's JSON `detail` and map it, e.g.
  "User is locked. Reason: Exhausted balance…" → "Account balance is
  exhausted — top up to continue." Raw text goes to the log file (4.7), not
  the banner. Add a "Top up balance" button (opens
  `https://fal.ai/dashboard/billing` via `openExternal`) next to "Get a key".
- **4.6 Real resolution.** Read the source size from
  `track.getSettings()` and the result size from `resultVideo.videoWidth/Height`
  (update on the `resize` event). The UI currently prints the *requested*
  size ("1024 × 1024"), while cameras deliver their own modes (1280 wide was
  measured). Session facts should show "requested 1024 · camera 1280×720".
- **4.7 Local log file.** Write to `userData/logs/miko.log` (append; rotate
  at 1 MB, keep 3). Add IPC `log:write(level, message)` for activity entries
  and session errors. Redact anything matching
  `[0-9a-f-]{36}:[0-9a-f]{32}` (fal keys) and `fal_jwt_token=[^&\s]+`.
  Never log frames. Add an "Open logs folder" button in the API key dialog
  (`shell.openPath`).
- **4.8 Virtual Try-on.** Price confirmed at $0.02/s on fal's
  `decart/lucy2-vton/realtime` page (2026-09-14), already set in
  `lib/billing-policy.js`.
  **[LIVE — ask owner]** one session with a garment reference — this mode has
  never been tested live.
- **4.9 OBS stream security.** Generate a random 16-byte hex token each time
  the server starts. Serve only `/<token>/` and `/<token>/stream.mjpeg`, and
  reject requests whose `Host` isn't `127.0.0.1:<port>` or `localhost:<port>`
  (DNS-rebinding protection for a live face stream). The returned URL
  includes the token.
- **4.10 OBS load.** The loop runs at 30fps (~6 MB/s of JPEG frames passed
  from renderer to main); the `main.js` comment says "~15x/second". Measure
  renderer CPU at 30 vs 20fps during a live session. Keep 30 unless one core
  goes above ~60%. Fix the comment.
- **4.11 Background throttling (gap 24).** Electron throttles timers in
  minimized windows (`webPreferences.backgroundThrottling` defaults to
  `true`), so the 30fps OBS loop likely drops to ~1fps when Miko is
  minimized, even though `AGENTS.md` treats streaming while minimized as a
  supported workflow. Set `backgroundThrottling: false` in `createWindow()`.
  Verify **without** connecting: via CDP, run a 33 ms `setInterval` that counts
  ticks, minimize the window for 10s, and compare tick counts before and after
  the change.
- **4.12 Accessibility.** Give `#liveTimer` `role="timer"` (its implicit
  `aria-live` is off). Today `role="status"` announces every second to screen
  readers.
- **4.13 Cleanup.** Remove the unused `APP_AUTH_HEADER` from
  `lib/lucy-config.ts`. Fix stale comments that refer to files that don't
  exist or old API shapes: `hooks/useLucyRealtime.ts`,
  `app/api/fal/token/route.ts`, `electron/key-store.ts`, and the
  "`duration` sent to POST /tokens/realtime" comment in `lucy-config.ts`.

---

## Phase 5 — tests (build alongside Phase 1)

**Setup:** add `vitest` as a devDependency and `"test": "vitest run"`.
Mock `@fal-ai/client` with `vi.mock`, so `realtime.connect` records the
handler (`tokenProvider`, `onResult`, `onError`) and returns `send`/`close`
spies. Also stub:
- a `FakeRTCPeerConnection` (`addTrack`, `getTransceivers`, `createOffer`,
  `setLocalDescription`, `setRemoteDescription`, `addIceCandidate`,
  `getStats`, `close`, and settable handlers you can fire);
- `navigator.mediaDevices.getUserMedia`, returning fake tracks with `stop`,
  `getSettings` and `applyConstraints`;
- `window.deepLiveCam.getToken`;
- `RTCRtpSender.getCapabilities`.

Use fake timers.

| Test | Expectation |
|------|-------------|
| T1 | First try: edit params sent → server `iceServers` → offer sent → answer → `ontrack` → state `live`; exactly one `fal.realtime.connect` call |
| T2 | Token 403 "Exhausted balance" → `error` in the same tick, no reconnect timer, one connect call |
| T3 | Guard blocks Start → `error` with the guard's reason, zero `fal.realtime.connect` calls |
| T4 | Guard blocks a scheduled reconnect → `error`, no connect call, no further timers |
| T5 | ICE `disconnected` then `connected` within 4s → stays `live`, no reconnect |
| T6 | ICE `disconnected` for 4s → `reconnecting`, a new connect after the backoff delay |
| T7 | `remainingSeconds = floor((effective − 1) / price)`, never negative |
| T8 | Reconciliation: unchanged poll keeps `unposted`; dropped poll reduces it; never negative |
| T9 | The budget-reached callback fires exactly once |
| T10 | Persisted meter state older than 15 min is ignored |
| T11 | Transient token-refresh failure while live → stays `live`, no teardown |
| T12 | Token refresh 403 while live → `error`, no reconnect |
| T13 | Loss % is computed per interval (delta), not cumulative |
| T14 | Poor quality steps resolution down via `applyConstraints` and never reconnects |
| T15 | `computeReferenceSize`: 4000×3000 → 1024×768; 3000×800 → short edge kept at 512; 600×600 unchanged |
| T16 | 5 keystrokes within 300 ms → one send after 600 ms; a reference change sends immediately |
| T17 | "Concurrent session limit reached" → first retry uses `CONCURRENCY_RETRY_BACKOFF_MS[0]` |
| T18 | `disconnect()` during `connecting` → no `error` state, no timers left, `close()` called |
| T19 | **Regression guard:** `fal.realtime.connect` is never passed a `connectionKey` (the phantom-billing bug) |

---

## SDK status (checked 2026-09-14)

- `@fal-ai/client` **1.10.1** is declared (`^1.10.1`), installed and locked,
  and is the latest stable on npm (2026-05-04). `npm audit --omit=dev`
  reports 0 vulnerabilities. Our setup matches fal's Lucy 2.5 docs: a
  `tokenProvider`, a matching `tokenExpirationSeconds`, no `connectionKey`.
- **1.11.0-alpha.0–3** (2026-08-28 → 09-08, no release notes) changes three
  things that matter here:
  - `close()` now marks the connection disposed and deletes its cache entry.
    That's fal's own fix for the leak behind gap 1 and `AGENTS.md` fact 6.
  - Token refresh stops once the connection leaves `active`.
  - There's an experimental **official Lucy WebRTC client**:
    `fal.realtime.open(lucyRealtime(), { input, localStream, tokenProvider,
    tokenExpirationSeconds, fallbackIceServers, negotiationTimeoutMs,
    onState, onError, onMedia, onDiagnostic })`. It "owns SDP/ICE ordering,
    remote-candidate buffering, and teardown", with states
    `opening → live → failed | closed`.
- **Recommendation:**
  - Stay on 1.10.1 for v1.0.1. The alpha API is marked experimental ("may
    change in a minor release").
  - Pin the exact version now (`"@fal-ai/client": "1.10.1"`). `^1.10.1`
    would pull 1.11.0 stable, with its rewritten realtime internals, on any
    `npm update` or lockfile regeneration.
  - Keep test T19.
  - Once 1.11.0 ships stable, evaluate replacing our hand-built
    `open()` / `buildPeerConnectionAndOffer()` / `handleSignal()` with
    `lucyRealtime()`, keeping our own start gate, billing meter, error
    classification and reconnect policy on top. Pin that exact version too.

## Phase 6 — Model picker: try both models

**Goal:** let the owner pick, per session, between the two live models on
fal, and compare quality and cost. That includes trying a full character
swap on the cheaper model.

| UI name (⛔ M1) | Endpoint | Price | Documented use |
|---|---|---|---|
| Miko Pro | `decart/lucy-2-5/realtime` | $0.04/s | Full character swap from a reference photo |
| Miko Lite | `decart/lucy2-vton/realtime` | $0.02/s | Outfit try-on. fal says its reference is used "as a character reference", but a full swap is **unproven** |

**The problem today:** `#modeSelect` (`index.html` settings drawer,
~170-175) picks the endpoint *and* the task together. "Character Swap" means
Pro plus the swap prompt; "Virtual Try-on" means Lite plus the outfit
prompt. There's no way to send a full-swap request to Lite. Split it into
two independent choices.

### 6.1 Two controls: Model and Task
- **Model** `#modelSelect` (value = endpoint). Move it out of the settings
  drawer into the "Source setup" panel next to the camera, since it's a
  per-session cost decision rather than a buried setting. Options:
  `Miko Pro — $0.04/s` and `Miko Lite — $0.02/s` (⛔ M3). Under it, a hint
  like `~2m 30s of live time before the $1 floor` from
  `billingMeter.remainingSeconds(model)`, updated whenever the model
  changes.
- **Task** `#taskSelect` (value `character` | `outfit`): "Full character
  swap" / "Outfit only". It only drives the default prompt, the
  reference-requirement text and the labels.
- Remove `#modeSelect`. No UI text may name Lucy, Decart or fal (ground rule 3).

### 6.2 Rewire what "mode" drives today
| Today (keyed by endpoint) | After |
|---|---|
| `DEFAULT_PROMPTS` in `app.js` (~19) **and** `main.js` (~27), two copies | Keyed by **task**, in one shared UMD module `lib/prompt-presets.js` (same pattern as `lib/billing-policy.js`). `main.js` requires it and `index.html` loads it; add it to `package.json` `build.files` |
| `referenceRequirementText()` (~158) | Keyed by task (person/character photo vs garment photo) |
| `updateModeCopy()` (~470), `#modeSummary`, `#modeFact` | Show e.g. "Pro · Full swap"; add a "Rate" row to Session facts |
| Prompt swap in the mode `change` handler (~890-900) | On **task** change, swap the prompt only if it still equals the previous task's default |
| `attachSession(elements.modeSelect.value)` | `attachSession(model)` on **model** change only (it already stops the old session and restarts the preview) |
| Every `billingMeter.*(elements.modeSelect.value)` call (~519-750) | Use the selected **model**. The rate always follows the model, never the task |

Model and Task stay disabled while connecting, live or reconnecting, the
same way `modeSelect` is today (~278).

### 6.3 Settings and migration
- New fields `model` (endpoint) and `task` (`character` | `outfit`). Stop
  writing `mode`.
- `sanitizeSettings` (`main.js` ~136):
  - `model` = a valid `source.model`, else a valid legacy `source.mode`,
    else Pro (⛔ M2).
  - `task` = a valid `source.task`, else `"outfit"` if legacy `source.mode`
    was the VTON endpoint, else `"character"`.

  Existing installs therefore keep behaving exactly as before.
- On a fresh install, the default prompt is the chosen task's preset.

### 6.4 No blocking, no pre-judging
Every model + task combination is allowed. Lite + Full character swap sends
the full-swap prompt and reference photo to Lite exactly as it would to Pro.
**Owner decision (2026-09-14): no warning or hint on this combination** —
the owner judges the result themselves. The only things that ever block
Start are the existing gates (balance floor, missing reference, missing key).

### 6.5 Cost comparison in the activity log
The session-end line (the one kept after the privacy clear, see 4.4)
includes the model and the estimated cost, e.g. "Session ended — Miko Lite,
42 s, est. $0.84". Lifecycle text only: no prompt text, no media.

### 6.6 Tests
| Test | Expectation |
|------|-------------|
| T20 | Migration: legacy `mode: VTON` → `model: VTON, task: outfit`; legacy `mode: Pro` → `model: Pro, task: character`; garbage → defaults |
| T21 | Rate follows the model: Lite + character bills at 0.02; Pro + outfit bills at 0.04 |
| T22 | A task change swaps the prompt only when it's the untouched default |
| T23 | Lite + character: `fal.realtime.connect` receives `decart/lucy2-vton/realtime`, and the first send carries the character prompt and reference |
| T24 | Same balance → Lite's runway hint shows twice Pro's |

T19 (no `connectionKey`) must still pass for both endpoints.

### 6.7 [LIVE — ask owner] The comparison run
Use the same camera, lighting, reference photo and "Full character swap"
task for both:
1. Lite, 15 s (~$0.30 plus connecting time)
2. Pro, 15 s (~$0.60 plus connecting time)

The balance needs to be at least ~$2.00 so both runs stay above the $1
floor. The owner judges identity match, stability over the 15 s, and
whether the body and clothing were replaced too. Record the verdict in
`AGENTS.md` hard-won facts. Whatever the result, the combination stays
available; labels or defaults change only if the owner asks.

**Informal real-world signal, 2026-09-14 (not this structured A/B yet):**
the owner hit exactly the predicted risk in real use — a Lite +
Full-character-swap session connected and billed normally but produced no
visible swap. Recorded as hard-won fact #7a in `AGENTS.md`. The actual
15s/15s A/B above still hasn't been run; do that before treating this as
fully confirmed either way.

### Owner decisions for Phase 6
| ID | Decision | Recommendation |
|----|----------|----------------|
| M1 | UI names for the two models | "Miko Pro" / "Miko Lite" |
| M2 | Default model on a fresh install | Pro, until 6.7 shows Lite can do full swaps |
| M3 | Show the per-second price in the picker | Yes, since choosing on cost is the whole point |

## Suggested order
Phase 0 (after D1) → Phase 5 setup → Phase 1 (1.1–1.6, each with its
tests) → 1.7 **[LIVE]** → Phase 2 → **Phase 6** (6.7 **[LIVE]**) →
Phase 3 → Phase 4 → release v1.0.1 (3.6).

When finished, update `AGENTS.md`: the Windows build steps (3.4), the billing
meter, and the charge-posting result from 1.7.

---

## Traceability — every review gap → its step

| # | Gap | Step |
|---|-----|------|
| 1 | Published v1.0.0 ships the phantom-billing bug | 0, 3.6 |
| 2 | ICE restart leaves the app stuck on "Reconnecting" while billing, guard off | 1.3 |
| 3 | "Try again" and auto-reconnect skip the $1 floor | 1.1 |
| 4 | Balance guard can't see spending during a call | 1.2, 1.7 |
| 5 | A token-refresh blip kills a working call | 1.4 |
| 6 | Poor network triggers a billed reconnect; network meter is cumulative | 1.5 |
| 7 | Start works with no reference image | 2.1 |
| 8 | Reference sent full size and re-sent on every keystroke | 2.2, 2.3 |
| 9 | Mac build lacks the camera entitlement; Gatekeeper rejects it | 3.1–3.3 |
| 10 | Windows build steps break on a fresh clone | 3.4 |
| 11 | No single-instance lock | 4.1 |
| 12 | Call stays live when the laptop sleeps | 4.2 |
| 13 | Mode switch leaks the camera | 4.3 |
| 14 | Activity log wipes errors | 4.4 |
| 15 | "fal" shown in the UI | 4.5 |
| 16 | Resolution labels show requested, not real, size | 4.6 |
| 17 | Packaged app keeps no log file | 4.7 |
| 18 | No tests on the billing-critical code | 5 |
| 19 | OBS stream has no access token / Host check | 4.9 |
| 20 | Virtual Try-on untested live; price assumed | 4.8 |
| 21 | Timer announces every second to screen readers | 4.12 |
| 22 | OBS 30fps load; comment says 15 | 4.10 |
| 23 | Stale React-era comments; unused `APP_AUTH_HEADER` | 4.13 |
| 24 | Minimized window throttles the OBS loop (and tick-based timing) | 4.11, 1.2 |
