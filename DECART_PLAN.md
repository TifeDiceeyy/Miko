# Decart direct — plan (approved 2026-09-15)

Goal: let Miko use a Decart API key directly, as an alternative to fal,
with the user choosing the key supplier.

**Status:** built with the recommended decisions D1–D4. Unit tests and the
non-billing checks pass, and the fal bundle is byte-identical. Live checks
L1–L6 are still to run: they need the owner's Decart key and OK.

**First live sessions (2026-09-15):** the connection worked (connected in
2.8–3.8 s). Two fixes followed: the SDK hands over the output once per track
with audio first, so Miko now waits for a video track; and the first frame
comes about 6–7 s after connecting, so the first frame now gets 30 s after
connecting (unbilled) instead of sharing the 10 s connect limit.
**No live Decart session without the owner's explicit OK** (same rule as
fal: every session bills a real account).

## Verdict: same project, no duplicate needed

Decart can be added as a second supplier without touching fal's working
path, because the two never share a connection layer:

| Stays exactly as it is (fal) | Why it's safe |
|---|---|
| `lib/lucy-realtime-session.ts`, `lib/realtime-socket-guard.ts` | Decart gets its own session class; the socket guard only wraps `fal.run` sockets |
| `@fal-ai/client` 1.10.1 pin and its workarounds | Decart's SDK is a separate package with no shared dependencies |
| `dist/lucy-session.bundle.js` | Decart ships as its own bundle, loaded only when Decart is chosen (checked: building it leaves the fal bundle byte-identical) |
| fal token minting, balance, payload deletion in `main.js` | Decart gets new, separate handlers |
| Every existing test | Must pass unchanged; the fal files must show no diff |

A duplicate project would only be needed if Decart required changing the
fal session, the global `WebSocket` guard or the fal bundle. It doesn't.

## What Decart direct offers (confirmed)

| | Decart direct | Miko on fal today |
|---|---|---|
| Full character swap | `lucy-2.5`, **$0.02/s**, 1280×720, 30 fps | `decart/lucy-2-5/realtime`, $0.04/s |
| Outfit try-on | `lucy-vton-3.5`, **$0.02/s**, 1280×720 | `decart/lucy2-vton/realtime`, $0.02/s |
| Billed for | seconds of active generation | per second of session |
| Balance API | **none** (only a concurrency quota) | yes (`/v1/account/billing`) |
| Browser credentials | client tokens (`ek_…`), 1–3600 s, model-scoped, session-length cap | short-lived fal tokens |
| Transport | SDK → signaling WebSocket → LiveKit media | fal SDK → hand-built WebRTC |

Use the exact model names, never `lucy-latest`: the SDK defines
`lucy-latest` as 1088×624, a different size.

## Wiring confirmed without a paid session

- **Auth:** REST uses the `x-api-key` header; the realtime WebSocket carries
  the key or client token as `api_key` in its URL
  (`@decartai/sdk` 0.2.0, `shared/request.js`, `realtime/client.js`).
- **Client tokens:** `POST https://api.decart.ai/v1/client/tokens` with
  `expiresIn` (1–3600 s, default 60), `allowedModels`,
  `constraints.realtime.maxSessionDuration` (≥ 10 s). Response `apiKey`
  (`ek_…`), `expiresAt`. An expiring token stops new connections but does
  not end a live session. A client token can't mint another token.
- **Probed:** the token endpoint answers `422` with no key and `401
  {"error":"Invalid or expired API key"}` with a bad key; the quota
  endpoint (`GET /v1/realtime/quota`) answers `401 {"detail":"Invalid API
  key"}`. These become precise messages.
- **Models:** `models.realtime("lucy-2.5")` → `/v1/stream`, 1280×720,
  30 fps; `lucy-vton-3.5` → `/v1/stream`, 1280×720, 30 fps.
- **Session input:** `initialState: { prompt: { text, enhance }, image }`
  at connect, then `set({ prompt, image, enhance })`. `set()` replaces the
  whole state, so Miko always sends prompt and image together. Enhance is
  on by default (matches Miko).
- **States:** `connecting`, `connected`, `generating`, `reconnecting`,
  `disconnected`. Events: `error` (`DecartSDKError` with `code`),
  `generationTick { seconds }`, `generationEnded { seconds, reason }`,
  `connectionQuality`, `queuePosition`.
- **Hosts and ports** (Decart's network requirements): `api.decart.ai`,
  `api3.decart.ai` (signaling), `lk.decart.ai` and `*.lkc.decart.ai`
  (LiveKit media signaling, regional), `platform.decart.ai` (telemetry),
  `stun.l.google.com`. TCP 443, UDP 7882 (media), UDP 3478 (TURN), UDP
  19302 (STUN).
- **Bundling:** the SDK plus `livekit-client` 2.20.2 bundles to a separate
  1,045 KB file for the renderer, with no `import.meta` left.
- **Three SDK behaviours Miko must control:**
  1. It **auto-reconnects** after a drop (5 attempts, backoff) and retries a
     failed connect. This can't be switched off. Miko stops the session at
     the first `reconnecting` or `error`; stopping disposes the session,
     which ends the SDK's retries.
  2. It sends **telemetry** to `platform.decart.ai` unless `telemetry:
     false` is passed. Miko passes it (lifecycle-only logging promise).
  3. Its **frame-timing worker** is created from `import.meta.url`. In a
     single-file bundle the runtime check fails and the SDK turns frame
     timing off instead of failing (`isFrameMetadataRuntimeSupported`
     returns false). Only the SDK's glass-to-glass latency figure is lost.

## Still to confirm (needs a Decart key; each run bills or uses free credits)

- **L1** A real connect in Electron: time to first video, and which
  `*.lkc.decart.ai` host is used (CSP check).
- **L2** Prompt and reference image take effect: character swap on
  `lucy-2.5`, outfit on `lucy-vton-3.5`.
- **L3** `generationTick` seconds match Miko's meter and Decart's dashboard.
- **L4** Stop really ends billing (no `generationTick` after Stop, no
  lingering session in the quota endpoint).
- **L5** A network drop mid-session: Miko stops cleanly instead of the SDK
  reconnecting in the background.
- **L6** OBS output and the network check work the same with a Decart
  session.

Estimated cost: about 2 minutes of generation, roughly $2.40 at $0.02/s,
or free with Decart's new-account credits.

## Owner decisions

- **D1 Supplier names in the UI.** Choosing a supplier means naming "fal"
  and "Decart" in the API key dialog, which bends the "Miko only" UI rule.
  *Recommended:* names only in the API key dialog, nowhere else.
- **D2 Billing safety without a balance API.** Decart has no balance
  endpoint, so the $1 floor can't be checked. *Recommended:* every Decart
  token carries `maxSessionDuration` (default 10 min); Miko's meter uses
  Decart's own `generationTick` seconds; plus an optional daily spend limit
  in Miko (for example $5) that blocks Start once reached.
- **D3 Model mapping.** *Recommended:* Miko Pro → `lucy-2.5` (swap), Miko
  Lite → `lucy-vton-3.5` (outfit). Leave `lucy-restyle-2` ($0.01/s) out
  for now.
- **D4 Telemetry.** *Recommended:* off.
- **D5 Live checks L1–L6** with a Decart key, about 2 minutes of generation.

## Design

### Supplier selection
- New setting `keySupplier: "fal" | "decart"`; missing means `"fal"`, so
  every existing install behaves exactly as today.
- API key dialog: supplier choice, one key field per supplier (both can be
  saved), and a "Get a key" link for each. Locked while a session is live,
  like the model and task selectors.

### Main process (`main.js`)
- Keys: `fal-key.store` unchanged; new `decart-key.store`
  (`safeStorage`). `DECART_API_KEY` env var as the scripted option, like
  `FAL_KEY`.
- New IPC `decart:get-token` → `POST /v1/client/tokens` with
  `expiresIn: 60`, `allowedModels: [model]`,
  `constraints: { realtime: { maxSessionDuration } }`. Returns only the
  `ek_…` token; the real key never reaches the renderer.
- Precise errors: `401` "The Decart API key was rejected — check it in
  Model settings → API key", `422`, `429`, `5xx` each named, never generic.
- Before Start: `GET /v1/realtime/quota`; if `remaining === 0`, say the
  account already has its maximum number of live sessions.
- Balance: fal unchanged. Decart shows "Decart doesn't report a balance;
  Miko tracks what each session costs" plus the D2 limits.
- Network check: target host by supplier (`fal.run` or `api3.decart.ai`).
  UDP 7882 can't be checked with a TCP connect; the existing video-link
  failure message covers a blocked UDP path.
- CSP `connect-src` additions (fal's entries stay): `https://api.decart.ai
  wss://api3.decart.ai wss://lk.decart.ai https://lk.decart.ai
  wss://*.lkc.decart.ai https://*.lkc.decart.ai`. `platform.decart.ai` is
  not added (telemetry off). Adjust after L1 if LiveKit needs more.
- Payload deletion stays fal-only (Decart has no equivalent endpoint).

### Renderer
- `lib/decart-realtime-session.ts`: `DecartRealtimeSession` with exactly
  the surface `app.js` uses today — `subscribe`, `getSnapshot`, `connect`,
  `disconnect`, `hardStop`, `previewCamera`, `updateEditParams`,
  `setPreferredResolution`, `setPreferredDeviceId`, `setConnectGuard` — and
  the snapshot fields `state`, `networkQuality`, `localStream`,
  `remoteStream`, `error`.
  - One attempt per Start, 10 s to first video (same as fal), then stop.
  - `reconnecting` or `error` → stop at once, with a precise message.
  - `generationTick` → billing meter; `connectionQuality` → network meter.
  - Camera captured at 1280×720 to match the model.
- `lib/decart-entry.ts` → `dist/decart-session.bundle.js`, injected by
  `app.js` only when Decart is the supplier (`script-src 'self'` already
  allows it). `app.js` picks the session class by supplier.
- OBS output unchanged: it reads the Result video either way.

### Billing policy
- Rates keyed by supplier and model: Decart `lucy-2.5` 0.02,
  `lucy-vton-3.5` 0.02; fal unchanged.

### Tests
- Unit: supplier setting defaults; token request body and error mapping;
  `DecartRealtimeSession` against a fake SDK client (state mapping,
  `reconnecting` → stop, 10 s cap, `set()` payload, ticks → meter).
- Guard: the fal bundle hash and the fal source files unchanged; every
  existing test passes untouched.
- CI: both jobs as today; the Decart bundle builds on Windows too.
- Live L1–L6 only with the owner's OK.

### Docs
README install guide (choosing a supplier, Decart key, pricing), AGENTS.md
fact for the Decart wiring, FIX_PLAN status.

## Order of work
1. Owner decisions D1–D5.
2. Main process: supplier setting, key store, token IPC, errors, quota,
   CSP, network-check host. Tests.
3. `DecartRealtimeSession`, its bundle and the supplier switch in
   `app.js`. Tests with a fake client; fal guard checks.
4. UI in the API key dialog; docs.
5. Live checks L1–L6 with the owner's OK; tune CSP and timing from them.
6. Release.

## Rollback
The supplier defaults to fal, and the Decart code lives in its own files.
Removing it means deleting those files and reverting small, isolated diffs
in `main.js`, `app.js`, `index.html`, `preload.js` and `package.json`.

## Sources
- SDK: `@decartai/sdk` 0.2.0 (npm; source read in `dist/`), github.com/DecartAI/sdk README
- Pricing: https://docs.platform.decart.ai/getting-started/pricing
- Lucy 2.5: https://docs.platform.decart.ai/models/realtime/lucy-2.5
- Virtual try-on: https://docs.platform.decart.ai/models/realtime/virtual-try-on
- Client tokens: https://docs.platform.decart.ai/getting-started/client-tokens and https://docs.platform.decart.ai/api-reference/create-client-token
- Realtime JS API: https://docs.platform.decart.ai/sdks/javascript-realtime
- Network requirements: https://docs.platform.decart.ai/integrations/network-requirements
- Realtime quota: https://docs.platform.decart.ai/api-reference/get-realtime-quota
