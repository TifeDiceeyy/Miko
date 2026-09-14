// Central config constants for the realtime renderer bundle.

export const REALTIME_ENDPOINTS = {
  /** General character swap. */
  characterSwap: "decart/lucy-2-5/realtime",
  /** Virtual try-on — better resemblance for clothing/appearance swaps. */
  virtualTryOn: "decart/lucy2-vton/realtime",
} as const;

export type RealtimeEndpoint =
  (typeof REALTIME_ENDPOINTS)[keyof typeof REALTIME_ENDPOINTS];

/**
 * Landscape (16:9) capture widths, ordered high -> low fidelity. A number
 * here is always a WIDTH; height is derived as `width * 9/16` everywhere
 * this is consumed (acquireLocalStream/stepResolution in
 * lucy-realtime-session.ts) rather than stored separately, so this stays a
 * simple number type — same as before, just no longer implying a square
 * (1:1) shape.
 *
 * fal/Decart's own model spec (docs.platform.decart.ai/models/realtime/
 * lucy-2.5, fetched 2026-09-14) states Lucy 2.5's native resolution is
 * **1280×720 landscape** (or 960×1080 portrait) — "the documentation makes
 * no mention of 1:1 aspect ratio support." This used to be
 * `[1024, 768, 512]` with `aspectRatio: 1` forced on every capture —
 * feeding the model a shape it was never documented to accept, which it
 * then has to crop/pad/resize internally. 1280 is the model's actual native
 * width; 960/640 are lower-fidelity fallback steps for
 * poor-network adaptive stepping (same mechanism as before), not
 * independently confirmed by Decart's docs as supported input sizes.
 */
export const RESOLUTION_STEPS = [1280, 960, 640] as const;
export type Resolution = (typeof RESOLUTION_STEPS)[number];

export const MIN_REFERENCE_IMAGE_DIMENSION = 512;
// fal/Decart's own reference-image guidance: "maintain sharp quality at
// ~1280px longest side" — that's also the cap lib/reference-policy.js
// resizes uploads to (was 1024px, needlessly softer than the model expects).
export const PREFERRED_REFERENCE_IMAGE_DIMENSION = 1280;

/**
 * How long to wait for the WebRTC video link to actually come up before
 * giving up on a connect attempt and hard-stopping the session. fal.ai's
 * realtime session (and billing) starts the moment its server accepts the
 * signaling connection, not when video reaches the client — so this is a
 * real, hard cap on billed time for an attempt that isn't going to connect
 * (at most about $0.40 on Miko Pro).
 *
 * The clock starts before the token is even requested, so it covers the
 * whole handshake: token, signaling, the service assigning a runner (its
 * iceServers push), offer/answer, ICE and the first video frame. 2 s (set
 * on 2026-09-14) was too short for that: the owner's next real Start timed
 * out every time. 10 s is the owner's choice. Every attempt logs how long
 * each step took ("Connected in …" / "Connect failed after …" in the log), so
 * this can be tuned from real numbers.
 *
 * There is no automatic reconnect: once this fires (or any other connect
 * failure occurs), the session is torn down completely and Start must be
 * pressed again manually. That's deliberate — a failed attempt already spent
 * real money without the user seeing anything, so silently retrying (and
 * potentially billing again) on their behalf is not this app's call to make.
 */
export const WEBRTC_CONNECT_TIMEOUT_MS = 10_000;

// Do not set a fixed `connectionKey`: the SDK caches signaling state by that
// key. Its random per-call default keeps each connect attempt isolated and
// prevents stale token-refresh timers from retaining an old billable session.

/** How often to poll RTCPeerConnection.getStats() for adaptive resolution. */
export const STATS_POLL_INTERVAL_MS = 2000;

/** getStats()-derived thresholds used to classify network quality. */
export const NETWORK_THRESHOLDS = {
  poorPacketLossPct: 5,
  fairPacketLossPct: 1.5,
  poorRttMs: 400,
  fairRttMs: 200,
} as const;
