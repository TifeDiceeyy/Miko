import { fal } from "@fal-ai/client";
import {
  NETWORK_THRESHOLDS,
  RESOLUTION_STEPS,
  STATS_POLL_INTERVAL_MS,
  WEBRTC_CONNECT_TIMEOUT_MS,
  type Resolution,
} from "./lucy-config";
import { installRealtimeSocketGuard } from "./realtime-socket-guard";

const socketGuard = installRealtimeSocketGuard((message) => {
  console.warn("[lucy]", message);
  if (typeof window !== "undefined") window.deepLiveCam?.logEvent?.("warn", message);
});

export type ConnectionState =
  | "idle"
  | "connecting"
  | "live"
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
export type ConnectGuard = (context: { endpoint: string }) => Promise<void>;

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
 * This class is UI-framework agnostic and held in a module-level singleton
 * (see `getLucySession` below), so one window cannot accidentally create
 * overlapping billable sessions.
 */
export class LucyRealtimeSession {
  private snapshot: LucySessionSnapshot;
  private listeners = new Set<Listener>();

  private pc: RTCPeerConnection | null = null;
  private connection: RealtimeConnectionHandle | null = null;
  private connectGuard: ConnectGuard | null = null;

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
  private requestIds = new Set<string>();
  private socketTicket: number | null = null;

  // Single-flight + intentional-close bookkeeping (Fix #2).
  private connecting = false;
  private closedIntentionally = false;

  private troubleGraceTimer: ReturnType<typeof setTimeout> | null = null;

  private statsTimer: ReturnType<typeof setInterval> | null = null;
  private lastStats: { packetsLost: number; packetsSent: number; timestamp: number } | null = null;
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

  /** One preflight gate for manual starts, retries, and automatic reconnects. */
  setConnectGuard(guard: ConnectGuard | null) {
    this.connectGuard = guard;
  }

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
   * Public connect entrypoint — a single attempt, never auto-retried. Success
   * goes live; any failure tears the session down completely and lands in
   * "error", where it stays until the user presses Start again.
   */
  async connect(): Promise<void> {
    if (this.connecting) return;
    if (this.snapshot.state === "live" || this.snapshot.state === "connecting") {
      return;
    }

    const attempt = ++this.attemptGeneration;
    this.connecting = true;
    this.closedIntentionally = false;

    try {
      this.setSnapshot({ state: "connecting", error: null });
      await this.connectGuard?.({ endpoint: this.endpoint });
      if (attempt !== this.attemptGeneration || this.closedIntentionally) return;
      // Close-before-open: tear down any existing (even half-open) session
      // before creating a new one. There is never more than one at a time.
      // The camera preview (if already running) survives this — connect()
      // reuses it instead of re-acquiring, so going live from an active
      // preview doesn't re-trigger a permission prompt or a visible blip.
      this.teardown({ keepIntentionalFlag: true, keepLocalStream: true });
      await this.open(attempt);
      if (attempt !== this.attemptGeneration || this.closedIntentionally) return;
      this.setSnapshot({ state: "live", error: null });
      this.startStatsPolling();
    } catch (err) {
      // disconnect() and endpoint switches deliberately invalidate the active
      // attempt. Their rejected promise must not turn the resulting Idle
      // state back into Error.
      if (attempt !== this.attemptGeneration || this.closedIntentionally) return;
      const message = this.describeError(err);
      // Invalidate this attempt before close() can emit a second, trailing
      // callback for the same backend failure.
      ++this.attemptGeneration;
      this.connecting = false;
      // Hard-stop unconditionally, regardless of which error this was — no
      // attempt is ever left lingering server-side waiting on a retry.
      this.teardown({ keepIntentionalFlag: true, keepLocalStream: true });
      this.setSnapshot({ state: "error", error: message });
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

  /**
   * Account/config/start-gate failures (exhausted balance, bad or missing API
   * key, unauthorized) need the user to actually do something before another
   * attempt could ever succeed. There is no auto-reconnect regardless, but
   * this still distinguishes "your account/config needs fixing" from a
   * transient mid-session hiccup for handleSignalingError's messaging.
   */
  private isUnrecoverableAccountError(err: unknown): boolean {
    const message = err instanceof Error ? err.message : typeof err === "string" ? err : "";
    return /402|insufficient.?(credit|balance|fund)|payment.?required|exhausted.?(credit|balance)|balance[^.]*exhausted|balance (check unavailable|is at or below)|could not verify account balance|reference image is required|choose a reference image|401|unauthorized|authentication failed|no api key configured|untrusted request|could not (be )?decrypt|could not save the api key/i.test(
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
    //
    // Each branch below names a DISTINCT, verified cause — never a guess
    // dressed up as a diagnosis. In particular, a VPN/firewall verdict is
    // only ever given when the underlying signal actually implicates local
    // connectivity (a real ICE/peer-connection failure, or a browser-level
    // DNS/fetch failure). Our own synthetic connect-timeout has no such
    // evidence — it only means "nothing happened in time" — so it gets an
    // honestly uncertain message instead of a confident wrong one.
    if (err instanceof Error || typeof err === "string") {
      const message = err instanceof Error ? err.message : err;

      if (/concurrent session limit reached|429|concurrent_requests_limit/i.test(message)) {
        return `Too many active sessions on this account right now — fal.ai needs a moment to free the previous worker. Wait a bit, then press Start again. (${message})`;
      }
      if (/402|insufficient.?(credit|balance|fund)|payment.?required|exhausted.?(credit|balance)|balance[^.]*exhausted/i.test(message)) {
        return `Insufficient balance — your account is out of credits. Add funds, then click Connect again. (${message})`;
      }
      if (/401|unauthorized|token/i.test(message)) {
        return `Authentication failed — your API key may be invalid or missing. Check it in Settings. (${message})`;
      }
      // Our own giving-up timer (see WEBRTC_CONNECT_TIMEOUT_MS) — not a
      // reported failure of any kind, just silence. The cause is genuinely
      // unknown: could be the local network, a VPN/firewall blocking
      // WebRTC's UDP path, or fal.ai's own service being slow to respond.
      // Must not claim to know which.
      if (/timed out waiting for webrtc/i.test(message)) {
        const seconds = WEBRTC_CONNECT_TIMEOUT_MS / 1000;
        return `The live video link didn't arrive within ${seconds}s, so the session was stopped. This can be your network, a VPN/firewall blocking WebRTC, or fal.ai's service responding slowly — try again, and check your connection if it keeps happening.`;
      }
      // ICE/peer connection actually negotiated and then broke — a real,
      // observed WebRTC connectivity failure, not a blind timeout. This is
      // the one case confident enough to name a firewall/VPN specifically.
      if (/ice connection|peer connection/i.test(message)) {
        return `The live video connection broke (${message}). This usually means a firewall, VPN, or restrictive network is blocking the WebRTC media path — check your network and try again.`;
      }
      // Browser/DNS/fetch-level failures: the browser itself could not even
      // reach the network, a stronger and more specific signal than a
      // WebRTC-only timeout.
      if (
        /sustained poor network|failed to fetch|fetch failed|could not reach fal\.ai|networkerror|err_name_not_resolved|err_internet_disconnected|err_connection|err_network|enotfound|econnrefused|econnreset|etimedout|eai_again/i.test(
          message
        )
      ) {
        return `Network problem, not your account or the app: ${message}. Check your internet connection (and any VPN) and try again.`;
      }
      return message;
    }
    return String(err);
  }

  /** Stops the live session. Deliberately leaves an active camera preview
   * running (see previewCamera()) — "Stop" ends the fal.ai connection, not
   * your ability to see your own camera. Use stopPreview() separately, or
   * hardStop(), to release the camera too. */
  disconnect() {
    ++this.attemptGeneration;
    this.closedIntentionally = true;
    this.connecting = false;
    this.clearTroubleGraceTimer();
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
      }, WEBRTC_CONNECT_TIMEOUT_MS);
    });

    // Every socket the SDK opens for this attempt is tied to this ticket, so
    // teardown can close it even mid-handshake (see realtime-socket-guard.ts).
    const ticket = socketGuard.beginAttempt();
    this.socketTicket = ticket;
    const isCurrent = () =>
      attempt === this.attemptGeneration && !this.closedIntentionally && socketGuard.isActive(ticket);
    // Never settling keeps the SDK from opening a socket, or scheduling
    // anything, for an attempt we've already abandoned.
    const neverSettles = () => new Promise<string>(() => {});

    // Signaling relay only — the peer connection itself isn't created yet;
    // it's built in buildPeerConnectionAndOffer once the server pushes
    // iceServers (see the SignalMessage docstring for why the order matters).
    try {
      this.connection = fal.realtime.connect<SignalMessage, SignalMessage>(this.endpoint, {
        // No connectionKey: the SDK then uses a fresh crypto.randomUUID() per
        // call. A fixed key made every attempt reuse one never-cleaned-up
        // cached state machine for the whole app lifetime.
        //
        // throttleInterval 0: in @fal-ai/client 1.10.1 the default 128 ms
        // throttle drops all but the last send in a burst (losing trickled ICE
        // candidates), and a send still pending when we close fires anyway —
        // on a closed connection that re-opens a brand-new, unseen session.
        throttleInterval: 0,
        // No tokenExpirationSeconds: the SDK then schedules no token refresh.
        // A token only matters when a socket opens (each reconnect mints a
        // fresh one), and the refresh timer kept running forever after a
        // failed connect because the SDK only clears it when leaving "active".
        //
        // The token comes from the main process over IPC; the renderer never
        // sees the key. fal's client swallows a rejected tokenProvider (it
        // goes authInProgress -> unauthorized -> idle without calling
        // onError), so a 403/401/429 at minting would otherwise only surface
        // as our generic 20 s timeout. The rejection handler below settles the
        // connect wait with the real error, then re-throws so the SDK's state
        // machine unwinds too.
        tokenProvider: (app: string) => {
          if (!isCurrent()) return neverSettles();
          return window.deepLiveCam.getToken(app).then(
            (token: string) => {
              if (!isCurrent()) return neverSettles();
              socketGuard.claimToken(token, ticket);
              return token;
            },
            (err: unknown) => {
              const error = err instanceof Error ? err : new Error(String(err));
              if (attempt === this.attemptGeneration) {
                if (this.connectReject) {
                  const reject = this.connectReject;
                  this.clearConnectWait();
                  reject(error);
                } else if (this.isUnrecoverableAccountError(error)) {
                  // A revoked key or exhausted account cannot sustain the call.
                  this.handleSignalingError(error, attempt);
                } else {
                  // A transient blip must not tear down a healthy peer
                  // connection and start another paid session.
                  this.setTransientError("Temporary account check failed; the live session is continuing.");
                }
              }
              throw error;
            }
          );
        },
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
      if (pc.iceConnectionState === "disconnected") {
        this.startIceDisconnectGrace();
      } else if (pc.iceConnectionState === "failed") {
        this.clearTroubleGraceTimer();
        this.handleConnectionTrouble(`ICE connection ${pc.iceConnectionState}`);
      } else if (pc.iceConnectionState === "connected" || pc.iceConnectionState === "completed") {
        this.recoverFromTransientDisconnect();
      }
    };

    pc.onconnectionstatechange = () => {
      if (attempt !== this.attemptGeneration || pc !== this.pc) return;
      if (pc.connectionState === "failed" || pc.connectionState === "closed") {
        this.handleConnectionTrouble(`Peer connection ${pc.connectionState}`);
      } else if (pc.connectionState === "connected") {
        this.recoverFromTransientDisconnect();
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
    if (typeof msg.request_id === "string") this.requestIds.add(msg.request_id);

    if (msg.type === "error" || msg.error) {
      const errText = typeof msg.error === "string" ? msg.error : JSON.stringify(msg.error);
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

  // Passes the RAW error/text through untouched — never pre-formats with
  // describeError() here. Both destinations below (connect()'s catch block,
  // and handleConnectionTrouble) already call describeError() exactly once
  // on whatever they receive; formatting here too would double-wrap the
  // message (e.g. a second "(Concurrent session limit reached.)" nested
  // inside the first).
  private handleSignalingError(err: unknown, attempt: number) {
    if (attempt !== this.attemptGeneration || this.closedIntentionally) return;
    if (this.connectReject) {
      const reject = this.connectReject;
      this.clearConnectWait();
      reject(err instanceof Error ? err : new Error(String(err)));
      return;
    }
    this.handleConnectionTrouble(err instanceof Error ? err.message : String(err));
  }

  // ---------------------------------------------------------------------
  // Connection trouble — always a hard stop, never a retry (see
  // WEBRTC_CONNECT_TIMEOUT_MS's doc comment for why)
  // ---------------------------------------------------------------------

  private troubleHandled = false;

  /** A precise, real reason should always accompany a state change — never a
   * made-up placeholder. Every call site below passes the RAW condition that
   * triggered it (an ICE/peer-connection state string, or signaling error
   * text) — describeError() here is the one and only place that turns it
   * into the accurate, user-facing message (see describeError's own doc
   * comment on why each category is kept distinct).
   *
   * Unconditional: whatever the cause — a mid-session account/config
   * failure, an ICE/peer-connection break, a stalled signaling error — the
   * session is torn down completely and left in "error" for the user to
   * retry manually. There is no reconnect schedule to route into. */
  private handleConnectionTrouble(reason: string) {
    if (this.closedIntentionally || this.troubleHandled) return;
    this.troubleHandled = true;

    ++this.attemptGeneration;
    this.connecting = false;
    this.clearTroubleGraceTimer();
    // A connect still waiting for video must settle, or its caller hangs.
    this.cancelConnectWait("connection interrupted");
    this.teardown({ keepIntentionalFlag: true, keepLocalStream: true });
    this.setSnapshot({ state: "error", error: this.describeError(reason), remoteStream: null });
  }

  private startIceDisconnectGrace() {
    if (this.closedIntentionally || this.troubleGraceTimer) return;
    this.troubleGraceTimer = setTimeout(() => {
      this.troubleGraceTimer = null;
      this.handleConnectionTrouble("ICE connection disconnected for 4s");
    }, 4000);
  }

  private recoverFromTransientDisconnect() {
    if (this.closedIntentionally) return;
    this.clearTroubleGraceTimer();
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

  private clearTroubleGraceTimer() {
    if (this.troubleGraceTimer) {
      clearTimeout(this.troubleGraceTimer);
      this.troubleGraceTimer = null;
    }
  }

  // ---------------------------------------------------------------------
  // Local media + adaptive resolution (Fix #4)
  // ---------------------------------------------------------------------

  private async acquireLocalStream(resolution: Resolution): Promise<MediaStream> {
    return navigator.mediaDevices.getUserMedia({
      video: {
        // 16:9 landscape, matching Lucy 2.5's documented native resolution
        // (1280×720) — see RESOLUTION_STEPS's doc comment. Both width and
        // height are given explicitly (not just aspectRatio) since some
        // browsers treat aspectRatio as a softer constraint.
        width: { ideal: resolution },
        height: { ideal: Math.round((resolution * 9) / 16) },
        aspectRatio: 16 / 9,
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

    stats.forEach((report) => {
      if (report.type === "outbound-rtp" && (report as { kind?: string }).kind === "video") {
        const r = report as unknown as { packetsSent?: number };
        packetsSent += r.packetsSent ?? 0;
      }
      if (report.type === "remote-inbound-rtp") {
        const r = report as unknown as { packetsLost?: number; roundTripTime?: number };
        packetsLost += r.packetsLost ?? 0;
        if (typeof r.roundTripTime === "number") rttMs = r.roundTripTime * 1000;
      }
    });

    const deltaSent = this.lastStats ? Math.max(0, packetsSent - this.lastStats.packetsSent) : 0;
    const deltaLost = this.lastStats ? Math.max(0, packetsLost - this.lastStats.packetsLost) : 0;
    const intervalPackets = deltaSent + deltaLost;
    const lossPct = intervalPackets > 0 ? (deltaLost / intervalPackets) * 100 : 0;
    const quality = this.classifyNetwork(lossPct, rttMs);
    this.setSnapshot({ networkQuality: quality });

    // Poor quality lowers resolution and warns. It never starts a fresh paid
    // session while the current peer connection remains alive.
    if (quality === "poor") {
      this.goodStatsStreak = 0;
      this.poorStatsStreak += 1;
      await this.stepResolution(-1);
      if (this.poorStatsStreak >= 4) {
        // ~8s of sustained poor quality at the default 2s poll interval.
        this.poorStatsStreak = 0;
        this.setTransientError(
          `Network quality is poor (packet loss ${lossPct.toFixed(1)}%${rttMs ? `, RTT ${Math.round(rttMs)}ms` : ""}); resolution was lowered to keep this session stable.`
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

    this.lastStats = { packetsLost, packetsSent, timestamp: Date.now() };
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

    const track = this.snapshot.localStream?.getVideoTracks()[0];
    if (!track) return;

    try {
      await track.applyConstraints({
        // 16:9 landscape — see acquireLocalStream()/RESOLUTION_STEPS's doc
        // comment for why this is no longer a square constraint.
        width: { ideal: nextResolution },
        height: { ideal: Math.round((nextResolution * 9) / 16) },
        aspectRatio: 16 / 9,
      });
      this.setSnapshot({ resolution: nextResolution });
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
    this.clearTroubleGraceTimer();
    if (this.transientErrorTimer) {
      clearTimeout(this.transientErrorTimer);
      this.transientErrorTimer = null;
    }

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
    // The SDK's close() only shuts a socket that's already open; this also
    // closes one of ours still mid-handshake.
    if (this.socketTicket !== null) {
      socketGuard.endAttempt(this.socketTicket);
      this.socketTicket = null;
    }
    this.pendingRemoteCandidates = [];
    for (const requestId of this.requestIds) {
      void window.deepLiveCam.deleteRequestPayload(requestId).catch((error) => {
        console.warn("[privacy] could not delete request payload", requestId, error);
      });
    }
    this.requestIds.clear();

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
    activeSession.hardStop();
    activeSession = null;
  }
  if (!activeSession) {
    activeSession = new LucyRealtimeSession(endpoint);
  }
  return activeSession;
}
