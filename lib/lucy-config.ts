// Central config constants for the realtime renderer bundle.

export const REALTIME_ENDPOINTS = {
  /** General character swap. */
  characterSwap: "decart/lucy-2-5/realtime",
  /** Virtual try-on — better resemblance for clothing/appearance swaps. */
  virtualTryOn: "decart/lucy2-vton/realtime",
} as const;

export type RealtimeEndpoint =
  (typeof REALTIME_ENDPOINTS)[keyof typeof REALTIME_ENDPOINTS];

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

// Do not set a fixed `connectionKey`: the SDK caches signaling state by that
// key. Its random per-call default keeps each reconnect isolated and prevents
// stale token-refresh timers from retaining an old billable session.

/** How often to poll RTCPeerConnection.getStats() for adaptive resolution. */
export const STATS_POLL_INTERVAL_MS = 2000;

/** getStats()-derived thresholds used to classify network quality. */
export const NETWORK_THRESHOLDS = {
  poorPacketLossPct: 5,
  fairPacketLossPct: 1.5,
  poorRttMs: 400,
  fairRttMs: 200,
} as const;
