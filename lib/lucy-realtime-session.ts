import { fal } from "@fal-ai/client";
import {
  CONCURRENCY_RETRY_BACKOFF_MS,
  MAX_CONCURRENCY_RETRY_ATTEMPTS,
  MAX_RECONNECT_ATTEMPTS,
  NETWORK_THRESHOLDS,
  RECONNECT_BACKOFF_MS,
  RESOLUTION_STEPS,
  STABLE_CONNECTION_KEY,
  STATS_POLL_INTERVAL_MS,
  TOKEN_DURATION_SECONDS,
  type Resolution,
} from "./lucy-config";

export type ConnectionState =
  | "idle"
  | "connecting"
  | "live"
  | "reconnecting"
  | "error";

export type NetworkQuality = "unknown" | "good" | "fair" | "poor";

export interface EditParams {
  prompt?: string;
  referenceImageUrl?: string;
  enablePromptExpansion?: boolean;
}

export interface LucySessionSnapshot {
  state: ConnectionState;
  error: string | null;
  networkQuality: NetworkQuality;
  resolution: Resolution;
  remoteStream: MediaStream | null;
  localStream: MediaStream | null;
}

type Listener = () => void;

/**
 * Wire shape for messages sent/received over the fal realtime signaling
 * connection.
 *
 * CONFIRMED against a real, production-tested implementation of this exact
 * endpoint (a sibling project's live-verified client, cross-checked against
 * an independently reverse-engineered second implementation) — not a guess:
 * - The SERVER sends `{type: "iceServers", iceServers: [...]}` first; the
 *   client must wait for this before creating its RTCPeerConnection at all.
 *   An offer built before this arrives goes out with the wrong ICE servers
 *   and, worse, arrives before the server is ready to receive it.
 *   Only after that does the CLIENT build the peer connection and send the
 *   first (and only) offer — there is no glare/perfect-negotiation case to
 *   handle, since the server only ever answers.
 * - Outgoing ICE candidates use `type: "icecandidate"` (no hyphen) — the
 *   earlier `"ice-candidate"` guess was wrong and likely caused the server
 *   to silently drop trickled candidates.
 * - `{type: "error", error: "..."}` carries fatal errors, including the
 *   literal string "Concurrent session limit reached." — confirmed to be
 *   something fal's backend can emit even from a single well-behaved client
 *   on a low concurrency tier (a GPU worker isn't freed instantly when a
 *   prior session closes), so it's handled as retryable, not fatal.
 */
interface SignalMessage {
  type?: "offer" | "answer" | "icecandidate" | "iceServers" | "error";
  sdp?: string;
  candidate?: RTCIceCandidateInit;
  iceServers?: RTCIceServer[];
  prompt?: string;
  reference_image_url?: string;
  enable_prompt_expansion?: boolean;
  error?: unknown;
  request_id?: string;
}

/** Minimal shape we rely on from `fal.realtime.connect`'s return value. */
interface RealtimeConnectionHandle {
  send(input: SignalMessage): void;
  close(): void;
}

// Emergency fallback only. In the normal protocol flow fal/Decart sends the
// session's authoritative ICE list (including any credentialed TURN relays)
// before we create the peer connection. Never pin DNS results here: public
// STUN addresses can rotate, while a stale literal IP quietly breaks users.
const DEFAULT_ICE_SERVERS: RTCIceServer[] = [
  { urls: "stun:stun.l.google.com:19302" },
  { urls: "stun:stun.cloudflare.com:3478" },
];

function toEditParamsWire(params: EditParams) {
  return {
    prompt: params.prompt,
    reference_image_url: params.referenceImageUrl,
    enable_prompt_expansion: params.enablePromptExpansion,
  };
}

/**
 * Owns exactly one realtime WebRTC session: the fal signaling connection,
 * the RTCPeerConnection, the local webcam stream, reconnect/backoff state,
 * and adaptive-resolution stats polling.
 *
 * This class is framework-agnostic and deliberately NOT React state — it is
 * held in a module-level singleton (see `getLucySession` below) so it
 * survives component re-renders and React StrictMode's dev double-invoke of
 * effects. `hooks/useLucyRealtime.ts` subscribes to it via
 * `useSyncExternalStore`.
 */
export class LucyRealtimeSession {
  private snapshot: LucySessionSnapshot;
  private listeners = new Set<Listener>();

  private pc: RTCPeerConnection | null = null;
  private connection: RealtimeConnectionHandle | null = null;

  private editParams: EditParams = {};

  // Resolves/rejects once open() knows whether the session actually came up
  // — specifically, once a remote track arrives (see buildPeerConnectionAndOffer),
  // not merely once the peer connection reports "connected". Also what lets
  // handleSignal's late-iceServers guard tell "still waiting" apart from
  // "already gave up or already live".
  private connectResolve: (() => void) | null = null;
  private connectReject: ((err: Error) => void) | null = null;
  private connectTimer: ReturnType<typeof setTimeout> | null = null;

  // Every signaling callback is tagged with the attempt that created it.
  // Closing/retrying increments this value, making late messages from an old
  // websocket harmless instead of letting them mutate the replacement session.
  private attemptGeneration = 0;
  private pendingRemoteCandidates: RTCIceCandidateInit[] = [];

  // Set when the most recent failure was fal's own "Concurrent session
  // limit reached" — switches scheduleReconnect to a longer, dedicated
  // backoff instead of the normal one (see scheduleReconnect).
  private isConcurrencyLimitError = false;

  // Single-flight + intentional-close bookkeeping (Fix #2).
  private connecting = false;
  private closedIntentionally = false;

  private reconnectAttempt = 0;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private iceRestartTried = false;

  private statsTimer: ReturnType<typeof setInterval> | null = null;
  private lastStats: { bytesSent: number; timestamp: number } | null = null;
  private goodStatsStreak = 0;
  private poorStatsStreak = 0;

  /** User's chosen ceiling from the resolution selector. Adaptive stepping
   * (Fix #4) can drop below this on a bad link but will never step above it. */
  private preferredResolution: Resolution = RESOLUTION_STEPS[0];

  /** Which camera to open; undefined lets the browser pick a default. */
  private preferredDeviceId: string | undefined;

  constructor(private readonly endpoint: string) {
    this.snapshot = {
      state: "idle",
      error: null,
      networkQuality: "unknown",
      resolution: RESOLUTION_STEPS[0],
      remoteStream: null,
      localStream: null,
    };
  }

  getEndpoint(): string {
    return this.endpoint;
  }

  subscribe = (listener: Listener): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  getSnapshot = (): LucySessionSnapshot => this.snapshot;

  private setSnapshot(patch: Partial<LucySessionSnapshot>) {
    this.snapshot = { ...this.snapshot, ...patch };
    for (const listener of this.listeners) listener();
  }

  /** Merge and (if live) push updated edit params without a full reconnect. */
  updateEditParams(params: EditParams) {
    this.editParams = { ...this.editParams, ...params };
    if (this.connection && this.snapshot.state === "live") {
      this.connection.send(toEditParamsWire(this.editParams));
    }
  }

  /**
   * Public connect entrypoint. Guarded so double-clicks, rapid re-renders,
   * and React StrictMode's double-invoke of effects can never stack a
   * second connection (Fix #2: single-flight guard + close-before-open).
   */
  async connect(isReconnect = false): Promise<void> {
    if (this.connecting) return;
    if (this.snapshot.state === "live" || this.snapshot.state === "connecting") {
      return;
    }

    const attempt = ++this.attemptGeneration;
    this.connecting = true;
    this.closedIntentionally = false;
    this.clearReconnectTimer();
    if (!isReconnect) {
      this.reconnectAttempt = 0;
      this.lastTroubleReason = null;
    }
    // Reset per attempt — only this attempt's actual failure (if any)
    // should decide which backoff schedule scheduleReconnect() picks.
    this.isConcurrencyLimitError = false;

    try {
      // Close-before-open: tear down any existing (even half-open) session
      // before creating a new one. There is never more than one at a time.
      // The camera preview (if already running) survives this — connect()
      // reuses it instead of re-acquiring, so going live from an active
      // preview doesn't re-trigger a permission prompt or a visible blip.
      this.teardown({ keepIntentionalFlag: true, keepLocalStream: true });
      this.setSnapshot({ state: "connecting", error: null });
      await this.open(attempt);
      if (attempt !== this.attemptGeneration || this.closedIntentionally) return;
      this.setSnapshot({ state: "live", error: null });
      this.reconnectAttempt = 0;
      this.iceRestartTried = false;
      this.isConcurrencyLimitError = false;
      this.startStatsPolling();
    } catch (err) {
      // disconnect() and endpoint switches deliberately invalidate the active
      // attempt. Their rejected promise must not turn the resulting Idle state
      // back into Error, or schedule a reconnect the user did not request.
      if (attempt !== this.attemptGeneration || this.closedIntentionally) return;
      const message = this.describeError(err);
      // Invalidate this attempt before close() can emit a second, trailing
      // callback for the same backend failure. Otherwise that duplicate can
      // cancel and replace the retry timer we are about to schedule.
      ++this.attemptGeneration;
      this.connecting = false;
      // Close whatever this failed attempt half-opened (e.g. a signaling
      // connection that never finished ICE) right away instead of leaving
      // it lingering server-side until the next retry's close-before-open —
      // that gap is exactly what can make repeated failures look like a
      // concurrency-limit problem even from a single client. The camera
      // preview is untouched.
      this.teardown({ keepIntentionalFlag: true, keepLocalStream: true });
      this.lastTroubleReason = message;
      this.setSnapshot({ state: "error", error: message });
      // Camera permission/device errors and account/config errors (bad key,
      // exhausted balance, unauthorized) need the user to fix something —
      // retrying on a timer just burns backoff attempts on a failure that
      // can't self-resolve. Leave those for a manual "Retry" click; only
      // auto-reconnect on transient network/signaling failures.
      if (!this.isUnrecoverableMediaError(err) && !this.isUnrecoverableAccountError(err)) {
        this.scheduleReconnect();
      }
    } finally {
      if (attempt === this.attemptGeneration) this.connecting = false;
    }
  }

  /** Only takes effect immediately when idle/errored; while live it just
   * raises/lowers the ceiling adaptive stepping is allowed to reach. If a
   * preview is already running, restarts it so the change is visible right
   * away instead of only on the next connect(). */
  setPreferredResolution(resolution: Resolution) {
    this.preferredResolution = resolution;
    if (this.snapshot.state === "idle" || this.snapshot.state === "error") {
      this.setSnapshot({ resolution });
      void this.restartPreview();
    }
  }

  /** Switches camera immediately if a preview is already running (or takes
   * effect on the next connect()/previewCamera() otherwise). */
  setPreferredDeviceId(deviceId: string | undefined) {
    this.preferredDeviceId = deviceId;
    void this.restartPreview();
  }

  /**
   * Starts showing the camera without connecting to fal.ai — lets the user
   * check framing/lighting and pick a device before committing to a live
   * (billable, concurrency-limited) session. Safe to call repeatedly; a
   * no-op while already previewing or while a real session owns the stream.
   */
  async previewCamera(): Promise<void> {
    if (this.snapshot.localStream) return;
    if (this.snapshot.state !== "idle" && this.snapshot.state !== "error") return;
    try {
      const stream = await this.acquireLocalStream(this.snapshot.resolution);
      this.setSnapshot({ localStream: stream, error: null });
    } catch (err) {
      // A background preview attempt failing (e.g. before permission is
      // granted) shouldn't throw up an error banner the user didn't ask
      // for yet — only surface it once they actually try to go live.
      console.warn("[lucy] camera preview unavailable:", this.describeError(err));
    }
  }

  /** Stops the preview. No-ops while a real session owns the camera. */
  stopPreview(): void {
    if (this.snapshot.state !== "idle" && this.snapshot.state !== "error") return;
    this.snapshot.localStream?.getTracks().forEach((track) => track.stop());
    this.setSnapshot({ localStream: null });
  }

  private async restartPreview(): Promise<void> {
    if (!this.snapshot.localStream) return;
    if (this.snapshot.state !== "idle" && this.snapshot.state !== "error") return;
    this.snapshot.localStream.getTracks().forEach((track) => track.stop());
    this.setSnapshot({ localStream: null });
    await this.previewCamera();
  }

  private isUnrecoverableMediaError(err: unknown): boolean {
    const name = err instanceof DOMException ? err.name : undefined;
    return (
      name === "NotAllowedError" ||
      name === "NotFoundError" ||
      name === "OverconstrainedError" ||
      name === "NotReadableError"
    );
  }

  /**
   * Account/config-level failures (exhausted balance, bad or missing API
   * key, unauthorized) need the user to actually do something before a
   * retry could ever succeed — auto-reconnecting on the same broken
   * credentials just burns through the whole RECONNECT_BACKOFF_MS ladder
   * (up to ~31s across 5 attempts) restating the identical failure every
   * time, which looks like flapping instead of one clear stop. Treated the
   * same way camera permission errors already are: surface once, stay in
   * Error state, and let the user retry manually after fixing the actual
   * problem (topping up balance, fixing the key in Settings).
   */
  private isUnrecoverableAccountError(err: unknown): boolean {
    const message = err instanceof Error ? err.message : typeof err === "string" ? err : "";
    return /402|insufficient.?(credit|balance|fund)|payment.?required|exhausted.?(credit|balance)|401|unauthorized|no api key configured|untrusted request|could not (be )?decrypt|could not save the api key/i.test(
      message
    );
  }

  private describeError(err: unknown): string {
    if (err instanceof DOMException) {
      switch (err.name) {
        case "NotAllowedError":
          return "Camera access was denied. Allow camera permission and click Connect again.";
        case "NotFoundError":
          return "No camera was found on this device.";
        case "NotReadableError":
          return "The camera is already in use by another application.";
        case "OverconstrainedError":
          return "The camera doesn't support the requested resolution.";
        default:
          break;
      }
    }
    // Signaling errors from fal arrive as plain strings (msg.error), not
    // Error objects — normalize both through the same pattern checks rather
    // than only recognizing these causes when something happened to wrap
    // them in an Error first.
    if (err instanceof Error || typeof err === "string") {
      const message = err instanceof Error ? err.message : err;
      if (/concurrent session limit reached|429|concurrent_requests_limit/i.test(message)) {
        return `Too many active sessions on this account right now (concurrency limit reached) — this can happen even with no client bug, since fal.ai takes a moment to free a worker after a prior session closes. Retrying automatically. (${message})`;
      }
      if (/402|insufficient.?(credit|balance|fund)|payment.?required|exhausted.?(credit|balance)/i.test(message)) {
        return `Insufficient balance — your account is out of credits. Add funds, then click Connect again. (${message})`;
      }
      if (/401|unauthorized|token/i.test(message)) {
        return `Authentication failed — your API key may be invalid or missing. Check it in Settings. (${message})`;
      }
      // Catches both our own generated reasons (ICE/peer connection state,
      // the WebRTC connect timeout, sustained packet loss) and generic
      // browser network failures (a dead fetch for the token request) —
      // called out explicitly so a bad connection isn't mistaken for a
      // broken app or account. The network-strength meter in the topbar
      // reflects the same signal while a session is live.
      if (
        /ice connection|peer connection|timed out waiting for webrtc|sustained poor network|failed to fetch|fetch failed|could not reach fal\.ai|networkerror|err_name_not_resolved|err_internet_disconnected|err_connection|err_network|enotfound|econnrefused|econnreset|etimedout|eai_again/i.test(
          message
        )
      ) {
        return `Network problem, not your account or the app: ${message}. Check your internet connection (and any VPN) and try again.`;
      }
      return message;
    }
    return String(err);
  }

  /** Stops the live session. Disables auto-reconnect. Deliberately leaves
   * an active camera preview running (see previewCamera()) — "Stop" ends
   * the fal.ai connection, not your ability to see your own camera. Use
   * stopPreview() separately, or hardStop(), to release the camera too. */
  disconnect() {
    ++this.attemptGeneration;
    this.closedIntentionally = true;
    this.connecting = false;
    this.clearReconnectTimer();
    this.cancelConnectWait("connection cancelled");
    this.stopStatsPolling();
    this.teardown({ keepIntentionalFlag: true, keepLocalStream: true });
    this.setSnapshot({ state: "idle", error: null, remoteStream: null });
  }

  // ---------------------------------------------------------------------
  // Connection setup
  // ---------------------------------------------------------------------

  private async open(attempt: number): Promise<void> {
    // Reuse an already-running preview instead of re-acquiring — avoids a
    // second permission prompt / camera light flicker when going live from
    // an active preview (see previewCamera()).
    const localStream = this.snapshot.localStream ?? (await this.acquireLocalStream(this.snapshot.resolution));
    if (attempt !== this.attemptGeneration || this.closedIntentionally) {
      if (localStream !== this.snapshot.localStream) {
        localStream.getTracks().forEach((track) => track.stop());
      }
      throw new Error("connection cancelled");
    }
    if (localStream !== this.snapshot.localStream) this.setSnapshot({ localStream });

    // Register the waiter before opening signaling. A cached token or very
    // fast server response can otherwise deliver iceServers/error before the
    // promise callbacks exist, causing a false 20-second timeout.
    const connected = new Promise<void>((resolve, reject) => {
      this.connectResolve = resolve;
      this.connectReject = reject;
      this.connectTimer = setTimeout(() => {
        if (attempt !== this.attemptGeneration) return;
        const rejectPending = this.connectReject;
        this.clearConnectWait();
        rejectPending?.(new Error("timed out waiting for WebRTC connection"));
      }, 20000);
    });

    // Signaling relay only — the peer connection itself isn't created yet;
    // it's built in buildPeerConnectionAndOffer once the server pushes
    // iceServers (see the SignalMessage docstring for why the order matters).
    try {
      this.connection = fal.realtime.connect<SignalMessage, SignalMessage>(this.endpoint, {
        connectionKey: STABLE_CONNECTION_KEY,
        tokenExpirationSeconds: TOKEN_DURATION_SECONDS,
        // Delegates to the main process over IPC — it holds the user's fal.ai
        // key (see electron/key-store.ts) and mints a short-lived token. The
        // renderer never sees the key itself.
        //
        // IMPORTANT: fal's realtime client swallows a rejected tokenProvider
        // internally — its connection state machine treats it as an
        // "unauthorized" transition back to idle (see @fal-ai/client's
        // realtime.js: authInProgress -> unauthorized -> idle via
        // expireToken/closeConnection) and never invokes the onError
        // callback below. Left alone, a 403 "balance exhausted", 401 bad
        // key, or 429 rate-limit at the token-minting stage would never
        // reach the user — it would just sit until our own 20s connect
        // timeout fired and reported a generic network problem. Catch the
        // rejection here ourselves and settle the connect wait immediately
        // with the real error, still re-throwing so the SDK's own state
        // machine also unwinds correctly.
        tokenProvider: (app: string) =>
          window.deepLiveCam.getToken(app).catch((err: unknown) => {
            const error = err instanceof Error ? err : new Error(String(err));
            if (attempt === this.attemptGeneration) {
              if (this.connectReject) {
                const reject = this.connectReject;
                this.clearConnectWait();
                reject(error);
              } else {
                // Token refresh failed mid-session (scheduleTokenRefresh)
                // rather than during initial connect — same silent-drop
                // problem, surfaced the same way a live-session signaling
                // error would be.
                this.handleSignalingError(error, attempt);
              }
            }
            throw error;
          }),
        onResult: (result: SignalMessage) => this.handleSignal(result, attempt),
        onError: (err: unknown) => this.handleSignalingError(err, attempt),
      });

      // Kick off the session: tells the server our current edit params, which
      // triggers it to allocate a runner and push back iceServers.
      this.connection.send(toEditParamsWire(this.editParams));
    } catch (err) {
      this.clearConnectWait();
      throw err;
    }

    // Resolves once a remote track actually arrives (in
    // buildPeerConnectionAndOffer's ontrack) — that's the real "it worked"
    // signal, not merely pc.connectionState flipping to "connected".
    await connected;
  }

  private clearConnectWait() {
    if (this.connectTimer) {
      clearTimeout(this.connectTimer);
      this.connectTimer = null;
    }
    this.connectResolve = null;
    this.connectReject = null;
  }

  private cancelConnectWait(reason: string) {
    const reject = this.connectReject;
    this.clearConnectWait();
    reject?.(new Error(reason));
  }

  /**
   * Builds the peer connection and sends the one-and-only offer, once the
   * server has told us it's ready (its iceServers push). Guarded against a
   * late/duplicate push: fal's backend can internally retry a failed runner
   * allocation and push iceServers a second time on the same signaling
   * socket — building a second, unwanted RTCPeerConnection from that stale
   * push (after this attempt already gave up or already went live) is a
   * real leak that compounds with every failed reconnect.
   */
  private async buildPeerConnectionAndOffer(iceServers: RTCIceServer[] | undefined, attempt: number) {
    if (attempt !== this.attemptGeneration || this.closedIntentionally) return;
    if ((!this.connectResolve && !this.connectReject) || this.pc) return;

    const pc = new RTCPeerConnection({ iceServers: iceServers?.length ? iceServers : DEFAULT_ICE_SERVERS });
    this.pc = pc;
    this.pendingRemoteCandidates = [];

    const localStream = this.snapshot.localStream;
    localStream?.getTracks().forEach((track) => pc.addTrack(track, localStream));
    this.tuneOutgoingVideo(pc);

    pc.ontrack = (event) => {
      if (attempt !== this.attemptGeneration || pc !== this.pc) return;
      const [remoteStream] = event.streams;
      if (remoteStream) this.setSnapshot({ remoteStream });
      if (this.connectResolve) {
        const resolve = this.connectResolve;
        this.clearConnectWait();
        resolve();
      }
    };

    pc.onicecandidate = (event) => {
      if (attempt === this.attemptGeneration && pc === this.pc && event.candidate) {
        this.sendSignal({ type: "icecandidate", candidate: event.candidate.toJSON() });
      }
    };

    pc.oniceconnectionstatechange = () => {
      if (attempt !== this.attemptGeneration || pc !== this.pc) return;
      if (pc.iceConnectionState === "disconnected" || pc.iceConnectionState === "failed") {
        this.handleConnectionTrouble(`ICE connection ${pc.iceConnectionState}`);
      }
    };

    pc.onconnectionstatechange = () => {
      if (attempt !== this.attemptGeneration || pc !== this.pc) return;
      if (pc.connectionState === "failed" || pc.connectionState === "closed") {
        this.handleConnectionTrouble(`Peer connection ${pc.connectionState}`);
      }
    };

    try {
      const offer = await pc.createOffer();
      await pc.setLocalDescription(offer);
      this.sendSignal({ type: "offer", sdp: pc.localDescription?.sdp });
    } catch (err) {
      if (this.connectReject) {
        const reject = this.connectReject;
        this.clearConnectWait();
        reject(err instanceof Error ? err : new Error(String(err)));
      }
    }
  }

  /**
   * Matches Decart's own reference WebRTC client (github.com/DecartAI/
   * Decart-XR — their Quest/XR integration, the only place they publish
   * real signaling + encoding code for this backend, since fal's own docs
   * stop at the fal.realtime.connect() boilerplate and never show the
   * WebRTC internals). Their client forces VP8 and sets explicit bitrate/
   * framerate on the outgoing video encoding. Leaving this to browser
   * defaults risks Chromium negotiating a codec their pipeline isn't tuned
   * for, and risks a visibly degraded swap for the first several seconds
   * while default bitrate ramps up from a low starting point.
   */
  private tuneOutgoingVideo(pc: RTCPeerConnection) {
    const transceiver = pc.getTransceivers().find((t) => t.sender.track?.kind === "video");
    if (!transceiver) return;

    try {
      const vp8Codecs = RTCRtpSender.getCapabilities?.("video")?.codecs.filter((c) => c.mimeType === "video/VP8") ?? [];
      if (vp8Codecs.length > 0 && transceiver.setCodecPreferences) {
        transceiver.setCodecPreferences(vp8Codecs);
      }
    } catch (err) {
      console.warn("[lucy] could not set VP8 codec preference, leaving default negotiation", err);
    }

    const sender = transceiver.sender;
    const params = sender.getParameters();
    if (!params.encodings || params.encodings.length === 0) params.encodings = [{}];
    params.encodings[0].maxBitrate = 4_000_000; // 4 Mbps ceiling, matches the reference client
    params.encodings[0].maxFramerate = 30;
    sender.setParameters(params).catch((err) => console.warn("[lucy] could not set encoding parameters", err));
  }

  private async handleSignal(msg: SignalMessage, attempt: number) {
    if (attempt !== this.attemptGeneration || this.closedIntentionally) return;

    if (msg.type === "error" || msg.error) {
      const errText = typeof msg.error === "string" ? msg.error : JSON.stringify(msg.error);
      this.isConcurrencyLimitError = /concurrent session limit reached/i.test(errText ?? "");
      if (this.connectReject) {
        const reject = this.connectReject;
        this.clearConnectWait();
        reject(new Error(errText || "signaling error"));
        return;
      }
      // No connect attempt pending — the model ended things on its own
      // mid-stream rather than during setup.
      this.handleSignalingError(msg.error ?? errText, attempt);
      return;
    }

    // Must arrive before the peer connection is built (see the
    // SignalMessage docstring) — everything else below requires this.pc
    // to already exist.
    if (msg.type === "iceServers" || (msg.iceServers && !this.pc)) {
      void this.buildPeerConnectionAndOffer(msg.iceServers, attempt);
      return;
    }

    const pc = this.pc;
    if (!pc) return;

    try {
      if (msg.type === "answer" && msg.sdp) {
        if (pc.signalingState === "have-local-offer") {
          await pc.setRemoteDescription({ type: "answer", sdp: msg.sdp });
          const queuedCandidates = this.pendingRemoteCandidates.splice(0);
          for (const candidate of queuedCandidates) await pc.addIceCandidate(candidate);
        }
      } else if ((msg.type === "icecandidate" || msg.candidate) && msg.candidate) {
        if (pc.remoteDescription) await pc.addIceCandidate(msg.candidate);
        else this.pendingRemoteCandidates.push(msg.candidate);
      }
    } catch (err) {
      this.setTransientError(`Failed to apply ${msg.type ?? "signal"}: ${this.describeError(err)}`);
    }
  }

  private sendSignal(message: SignalMessage) {
    this.connection?.send(message);
  }

  private handleSignalingError(err: unknown, attempt: number) {
    if (attempt !== this.attemptGeneration || this.closedIntentionally) return;
    const reason = `Signaling error: ${this.describeError(err)}`;
    this.isConcurrencyLimitError = /concurrent session limit reached/i.test(reason);
    if (this.connectReject) {
      const reject = this.connectReject;
      this.clearConnectWait();
      reject(new Error(reason));
      return;
    }
    this.handleConnectionTrouble(reason, this.isUnrecoverableAccountError(err));
  }

  // ---------------------------------------------------------------------
  // Reconnect logic (Fix #1)
  // ---------------------------------------------------------------------

  private troubleHandled = false;
  private lastTroubleReason: string | null = null;

  /** A precise, real reason should always accompany a state change — never a
   * made-up placeholder. Every call site below passes the actual condition
   * that triggered it (ICE state, peer connection state, the real error
   * object, or the specific network metric that crossed a threshold).
   *
   * `unrecoverable` marks a mid-session account/config failure (e.g. a
   * token-refresh rejected because the balance ran out or the key was
   * revoked while live) — an ICE restart or reconnect loop can't fix that,
   * so skip straight to a terminal Error state instead of masking one
   * account failure behind a "Reconnecting…" cycle that would only repeat
   * it every few seconds. */
  private async handleConnectionTrouble(reason?: string, unrecoverable = false) {
    if (reason) this.lastTroubleReason = reason;
    if (this.closedIntentionally || this.troubleHandled) return;
    this.troubleHandled = true;

    if (unrecoverable) {
      ++this.attemptGeneration;
      this.clearReconnectTimer();
      this.teardown({ keepIntentionalFlag: true, keepLocalStream: true });
      this.setSnapshot({ state: "error", error: reason ?? this.lastTroubleReason, remoteStream: null });
      return;
    }

    this.setSnapshot({ state: "reconnecting", error: reason ?? this.lastTroubleReason });

    const pc = this.pc;
    if (pc && !this.iceRestartTried) {
      this.iceRestartTried = true;
      try {
        // First line of defense: ICE restart, cheaper than a full teardown.
        pc.restartIce();
        // restartIce() alone doesn't renegotiate on all browsers; force it.
        const offer = await pc.createOffer({ iceRestart: true });
        await pc.setLocalDescription(offer);
        this.sendSignal({ type: "offer", sdp: pc.localDescription?.sdp });
        this.troubleHandled = false;
        return;
      } catch (err) {
        console.warn("[lucy] ICE restart failed, falling back to full reconnect", err);
      }
    }

    this.scheduleReconnect();
  }

  private scheduleReconnect() {
    if (this.closedIntentionally) return;
    this.clearReconnectTimer();

    // A concurrency-limit failure gets its own longer, more patient backoff
    // (see CONCURRENCY_RETRY_BACKOFF_MS) — it's expected server-side
    // behavior on a low tier, not a fault to give up on quickly.
    const schedule = this.isConcurrencyLimitError ? CONCURRENCY_RETRY_BACKOFF_MS : RECONNECT_BACKOFF_MS;
    const maxAttempts = this.isConcurrencyLimitError ? MAX_CONCURRENCY_RETRY_ATTEMPTS : MAX_RECONNECT_ATTEMPTS;

    if (this.reconnectAttempt >= maxAttempts) {
      this.setSnapshot({
        state: "error",
        error: `Reconnect failed after multiple attempts (last cause: ${
          this.lastTroubleReason ?? "unknown — see console"
        }). Click Connect to retry manually.`,
      });
      return;
    }

    const delay = schedule[this.reconnectAttempt];
    this.reconnectAttempt += 1;
    this.setSnapshot({ state: "reconnecting", error: this.lastTroubleReason });

    // Never a tight loop — exponential backoff (Fix #1).
    this.reconnectTimer = setTimeout(() => {
      this.troubleHandled = false;
      this.iceRestartTried = false;
      void this.connect(true);
    }, delay);
  }

  /** For non-fatal, per-message failures (a stray SDP/ICE apply error, a
   * failed resolution switch) — shows the precise error without forcing a
   * reconnect, and clears itself automatically once the session is
   * otherwise healthy so it doesn't linger forever. */
  private transientErrorTimer: ReturnType<typeof setTimeout> | null = null;
  private setTransientError(message: string) {
    console.error("[lucy]", message);
    this.setSnapshot({ error: message });
    if (this.transientErrorTimer) clearTimeout(this.transientErrorTimer);
    this.transientErrorTimer = setTimeout(() => {
      if (this.snapshot.state === "live") this.setSnapshot({ error: null });
    }, 6000);
  }

  private clearReconnectTimer() {
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
  }

  // ---------------------------------------------------------------------
  // Local media + adaptive resolution (Fix #4)
  // ---------------------------------------------------------------------

  private async acquireLocalStream(resolution: Resolution): Promise<MediaStream> {
    return navigator.mediaDevices.getUserMedia({
      video: {
        width: { ideal: resolution },
        height: { ideal: resolution },
        aspectRatio: 1,
        deviceId: this.preferredDeviceId ? { exact: this.preferredDeviceId } : undefined,
      },
      audio: false,
    });
  }

  private startStatsPolling() {
    this.stopStatsPolling();
    this.lastStats = null;
    this.goodStatsStreak = 0;
    this.poorStatsStreak = 0;
    this.statsTimer = setInterval(() => void this.pollStats(), STATS_POLL_INTERVAL_MS);
  }

  private stopStatsPolling() {
    if (this.statsTimer) {
      clearInterval(this.statsTimer);
      this.statsTimer = null;
    }
  }

  private async pollStats() {
    const pc = this.pc;
    if (!pc) return;
    const stats = await pc.getStats();

    let packetsLost = 0;
    let packetsSent = 0;
    let rttMs: number | null = null;
    let bytesSent = 0;

    stats.forEach((report) => {
      if (report.type === "outbound-rtp" && (report as { kind?: string }).kind === "video") {
        const r = report as unknown as {
          packetsSent?: number;
          bytesSent?: number;
        };
        packetsSent += r.packetsSent ?? 0;
        bytesSent += r.bytesSent ?? 0;
      }
      if (report.type === "remote-inbound-rtp") {
        const r = report as unknown as { packetsLost?: number; roundTripTime?: number };
        packetsLost += r.packetsLost ?? 0;
        if (typeof r.roundTripTime === "number") rttMs = r.roundTripTime * 1000;
      }
    });

    const lossPct = packetsSent > 0 ? (packetsLost / (packetsSent + packetsLost)) * 100 : 0;
    const quality = this.classifyNetwork(lossPct, rttMs);
    this.setSnapshot({ networkQuality: quality });

    // Sustained high loss / bad RTT is itself a signal to kick the
    // reconnect path (Fix #4 ties into Fix #1) — not just a resolution step.
    // A link can be bad enough to blockify the swap without ever tripping
    // an ICE disconnected/failed state, so this is the independent trigger.
    if (quality === "poor") {
      this.goodStatsStreak = 0;
      this.poorStatsStreak += 1;
      await this.stepResolution(-1);
      if (this.poorStatsStreak >= 4) {
        // ~8s of sustained poor quality at the default 2s poll interval.
        this.poorStatsStreak = 0;
        this.handleConnectionTrouble(
          `Sustained poor network (packet loss ${lossPct.toFixed(1)}%${rttMs ? `, RTT ${Math.round(rttMs)}ms` : ""})`
        );
      }
    } else if (quality === "good") {
      this.poorStatsStreak = 0;
      this.goodStatsStreak += 1;
      // Only step back up after a sustained streak of good samples so we
      // don't thrash between resolutions on a borderline link.
      if (this.goodStatsStreak >= 5) {
        this.goodStatsStreak = 0;
        await this.stepResolution(1);
      }
    } else {
      this.goodStatsStreak = 0;
      this.poorStatsStreak = 0;
    }

    this.lastStats = { bytesSent, timestamp: Date.now() };
  }

  private classifyNetwork(lossPct: number, rttMs: number | null): NetworkQuality {
    if (lossPct >= NETWORK_THRESHOLDS.poorPacketLossPct || (rttMs ?? 0) >= NETWORK_THRESHOLDS.poorRttMs) {
      return "poor";
    }
    if (lossPct >= NETWORK_THRESHOLDS.fairPacketLossPct || (rttMs ?? 0) >= NETWORK_THRESHOLDS.fairRttMs) {
      return "fair";
    }
    return "good";
  }

  /** direction: -1 steps down (lower res), +1 steps up (higher res). */
  private async stepResolution(direction: -1 | 1) {
    const currentIndex = RESOLUTION_STEPS.indexOf(this.snapshot.resolution);
    const nextIndex = currentIndex - direction; // steps array is high -> low
    const clamped = Math.min(Math.max(nextIndex, 0), RESOLUTION_STEPS.length - 1);
    if (clamped === currentIndex) return;

    const nextResolution = RESOLUTION_STEPS[clamped];
    // Never auto-step above the user's chosen ceiling (only downward
    // degradation is automatic; recovering back up stops at their pick).
    if (direction === 1 && nextResolution > this.preferredResolution) return;

    const pc = this.pc;
    const sender = pc?.getSenders().find((s) => s.track?.kind === "video");
    if (!pc || !sender) return;

    try {
      const newStream = await this.acquireLocalStream(nextResolution);
      const [newTrack] = newStream.getVideoTracks();
      const oldStream = this.snapshot.localStream;
      await sender.replaceTrack(newTrack);
      oldStream?.getTracks().forEach((t) => t.stop());
      this.setSnapshot({ resolution: nextResolution, localStream: newStream });
    } catch (err) {
      this.setTransientError(`Couldn't switch to ${nextResolution}px: ${this.describeError(err)}`);
    }
  }

  // ---------------------------------------------------------------------
  // Teardown
  // ---------------------------------------------------------------------

  /**
   * Tears down the peer connection and signaling connection, and — unless
   * keepLocalStream is set — the local camera too. Called on every
   * connect() (close-before-open, with keepLocalStream so an active
   * preview survives), on disconnect() (same), and on hardStop() (without,
   * for a full release).
   */
  private teardown(opts: { keepIntentionalFlag?: boolean; keepLocalStream?: boolean } = {}) {
    if (!opts.keepIntentionalFlag) this.closedIntentionally = true;

    this.stopStatsPolling();
    this.troubleHandled = false;
    this.iceRestartTried = false;

    if (this.pc) {
      this.pc.ontrack = null;
      this.pc.onicecandidate = null;
      this.pc.onnegotiationneeded = null;
      this.pc.oniceconnectionstatechange = null;
      this.pc.onconnectionstatechange = null;
      this.pc.close();
      this.pc = null;
    }

    this.connection?.close();
    this.connection = null;
    this.pendingRemoteCandidates = [];

    if (!opts.keepLocalStream) {
      this.snapshot.localStream?.getTracks().forEach((track) => track.stop());
      this.setSnapshot({ localStream: null });
    }
  }

  /** Called from window unload/hide handlers — stops the live session AND
   * releases the camera (unlike disconnect() alone, which keeps previewing). */
  hardStop() {
    this.disconnect();
    this.stopPreview();
  }
}

let activeSession: LucyRealtimeSession | null = null;
let globalHandlersRegistered = false;

function registerGlobalTeardownHandlers() {
  if (globalHandlersRegistered || typeof window === "undefined") return;
  globalHandlersRegistered = true;

  const stop = () => activeSession?.hardStop();

  // Tear down when the page/window is actually closing. Do not stop merely
  // because document.visibilityState becomes hidden: minimizing Miko while
  // sending its output to OBS is a normal background workflow and must keep
  // the camera, WebRTC session, and token refresh alive.
  window.addEventListener("pagehide", stop);
  window.addEventListener("beforeunload", stop);
}

/**
 * Returns the single app-wide realtime session, creating it on first use.
 * Switching endpoints (e.g. character-swap -> virtual-try-on) closes the
 * previous session first — there is never more than one live connection.
 */
export function getLucySession(endpoint: string): LucyRealtimeSession {
  registerGlobalTeardownHandlers();
  if (activeSession && activeSession.getEndpoint() !== endpoint) {
    activeSession.disconnect();
    activeSession = null;
  }
  if (!activeSession) {
    activeSession = new LucyRealtimeSession(endpoint);
  }
  return activeSession;
}
