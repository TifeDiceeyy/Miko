// Central config constants shared between the client hook and the API routes.
// Keeping these in one place makes it obvious when client/server values must
// stay in sync (see TOKEN_DURATION_SECONDS below).

export const REALTIME_ENDPOINTS = {
  /** General character swap. */
  characterSwap: "decart/lucy-2-5/realtime",
  /** Virtual try-on — better resemblance for clothing/appearance swaps. */
  virtualTryOn: "decart/lucy2-vton/realtime",
} as const;

export type RealtimeEndpoint =
  (typeof REALTIME_ENDPOINTS)[keyof typeof REALTIME_ENDPOINTS];

/**
 * Must match the `duration` sent to POST /tokens/realtime on the server
 * (app/api/fal/token/route.ts) AND the `tokenExpirationSeconds` passed to
 * fal.realtime.connect() on the client. A mismatch here is the #1 cause of
 * "the connection silently dies and won't reconnect" per fal's own docs.
 */
export const TOKEN_DURATION_SECONDS = 120;

/** Square capture resolutions, ordered high -> low fidelity. */
export const RESOLUTION_STEPS = [1024, 768, 512] as const;
export type Resolution = (typeof RESOLUTION_STEPS)[number];

export const MIN_REFERENCE_IMAGE_DIMENSION = 512;
export const PREFERRED_REFERENCE_IMAGE_DIMENSION = 768;

/** Exponential backoff schedule for reconnect attempts, in ms. */
export const RECONNECT_BACKOFF_MS = [1000, 2000, 4000, 8000, 16000] as const;
export const MAX_RECONNECT_ATTEMPTS = RECONNECT_BACKOFF_MS.length;

/**
 * "Concurrent session limit reached" is a distinct case: fal's realtime
 * backend can take a real, variable amount of time to free a GPU worker
 * after a prior session closes, so this can trip on a reconnect with zero
 * client bug involved, and it clears on its own a few attempts later.
 * The first retry deliberately waits a full 30 seconds so a just-closed GPU
 * worker has time to release before the app makes its second request. Later
 * attempts remain at least as patient instead of speeding back up, while the
 * finite schedule still prevents a genuinely blocked account retrying forever.
 */
export const CONCURRENCY_RETRY_BACKOFF_MS = [30000, 30000, 45000, 60000, 90000] as const;
export const MAX_CONCURRENCY_RETRY_ATTEMPTS = CONCURRENCY_RETRY_BACKOFF_MS.length;

/**
 * One constant key for the whole app. `fal.realtime.connect` uses this to
 * dedupe/reuse the same logical connection across re-renders instead of
 * spawning a parallel one — see Fix #2 in the master prompt.
 */
export const STABLE_CONNECTION_KEY = "lucy-realtime-singleton";

/** How often to poll RTCPeerConnection.getStats() for adaptive resolution. */
export const STATS_POLL_INTERVAL_MS = 2000;

/** getStats()-derived thresholds used to classify network quality. */
export const NETWORK_THRESHOLDS = {
  poorPacketLossPct: 5,
  fairPacketLossPct: 1.5,
  poorRttMs: 400,
  fairRttMs: 200,
} as const;

export const APP_AUTH_HEADER = "x-app-secret";
