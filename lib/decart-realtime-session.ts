// Decart's own realtime API, as a second key supplier next to fal. It has
// the same public surface as LucyRealtimeSession (the parts app.js uses), so
// app.js can drive either. It's built into its own bundle (lib/decart-entry.ts
// → dist/decart-session.bundle.js) and loaded only when Decart is chosen, so
// nothing here touches the fal path.
//
// Decart's SDK (@decartai/sdk) connects through a signaling WebSocket and a
// LiveKit room. It retries a failed connect and reconnects after a drop by
// itself, and neither can be switched off. So this class enforces Miko's own
// rules on top: one attempt per Start, 10 s to connect then 30 s for the first
// frame, and a stop at the first "reconnecting" or error. Stopping disposes the SDK session, which
// ends its retries.
import type { ConnectGuard, ConnectionState, EditParams, NetworkQuality } from "./lucy-realtime-session";

export const DECART_CONNECT_TIMEOUT_MS = 10_000;
// After connecting, the service prepares the model (reference image, prompt
// enhancement) before its first frame: about 6–7 s in the owner's first
// sessions. Decart bills only seconds of active generation, which starts
// with that frame, so this wait isn't billed.
export const DECART_FIRST_FRAME_TIMEOUT_MS = 30_000;
// Lucy 2.5 and VTON 3.5's native size (from the SDK's own model definitions).
const CAPTURE_WIDTH = 1280;
const CAPTURE_HEIGHT = 720;
const EDIT_PUSH_DELAY_MS = 300;

export interface DecartSnapshot {
  state: ConnectionState;
  error: string | null;
  networkQuality: NetworkQuality;
  resolution: number;
  remoteStream: MediaStream | null;
  localStream: MediaStream | null;
}

// The parts of @decartai/sdk this class uses, so tests can pass a fake.
export interface DecartRealtimeClient {
  set(input: { prompt?: string; image?: string; enhance?: boolean }): Promise<void>;
  disconnect(): void;
  on(event: string, listener: (data: any) => void): void;
}

export interface DecartSdk {
  createDecartClient(options: { apiKey: string; telemetry?: boolean }): {
    realtime: { connect(stream: MediaStream, options: Record<string, unknown>): Promise<DecartRealtimeClient> };
  };
  models: { realtime(name: string): unknown };
}

export interface DecartBridge {
  getToken(model: string): Promise<string>;
  logEvent?(level: "info" | "warn" | "error", message: string): void;
}

const STEP_ORDER = ["token", "connected", "generating", "video"] as const;
type Step = (typeof STEP_ORDER)[number];

// Already written for the user (a start-check or token message from the main
// process): shown as-is.
class UserFacingError extends Error {}
class ConnectionDropped extends Error {}
class SessionEnded extends Error {}

function rawMessage(error: unknown): string {
  const message = error instanceof Error ? error.message : typeof error === "string" ? error : "";
  // Errors thrown in the main process arrive wrapped by Electron's IPC.
  return message.replace(/^Error invoking remote method '[^']+': (?:Error: )?/, "");
}

export class DecartRealtimeSession {
  private snapshot: DecartSnapshot = {
    state: "idle",
    error: null,
    networkQuality: "unknown",
    resolution: CAPTURE_WIDTH,
    remoteStream: null,
    localStream: null
  };
  private readonly listeners = new Set<() => void>();
  private editParams: EditParams = {};
  private connectGuard: ConnectGuard | null = null;
  private preferredDeviceId: string | undefined;
  private client: DecartRealtimeClient | null = null;
  private attempt = 0;
  private abortConnect: ((reason: Error) => void) | null = null;
  private connectTimer: ReturnType<typeof setTimeout> | null = null;
  private pushTimer: ReturnType<typeof setTimeout> | null = null;
  private lastPushed = "";
  private steps: { attempt: number; startedAt: number; reached: Map<Step, number> } | null = null;
  private billedSeconds = 0;
  private endedReason: string | null = null;
  private lastQueue = "";
  private trackKindsSeen = new Set<string>();

  constructor(
    private readonly model: string,
    private readonly sdk: DecartSdk,
    private readonly bridge: DecartBridge
  ) {}

  getEndpoint(): string {
    return this.model;
  }

  getSnapshot(): DecartSnapshot {
    return this.snapshot;
  }

  /** Seconds of generation the service reported for the current or last session. */
  getBilledSeconds(): number {
    return this.billedSeconds;
  }

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  setConnectGuard(guard: ConnectGuard | null) {
    this.connectGuard = guard;
  }

  updateEditParams(params: EditParams) {
    this.editParams = { ...this.editParams, ...params };
    if (this.snapshot.state === "live") this.schedulePush();
  }

  // The session runs at the model's own size; Miko's resolution ceiling
  // (a fal setting) doesn't apply.
  setPreferredResolution(_resolution: number) {}

  setPreferredDeviceId(deviceId: string | undefined) {
    this.preferredDeviceId = deviceId;
    void this.restartPreview();
  }

  async previewCamera(): Promise<void> {
    if (this.snapshot.localStream) return;
    if (this.snapshot.state !== "idle" && this.snapshot.state !== "error") return;
    try {
      const stream = await this.acquireLocalStream();
      this.setSnapshot({ localStream: stream, error: null });
    } catch (error) {
      // Only surfaced once the user actually tries to go live.
      console.warn("[decart] camera preview unavailable:", this.describeError(error));
    }
  }

  stopPreview(): void {
    if (this.snapshot.state !== "idle" && this.snapshot.state !== "error") return;
    this.snapshot.localStream?.getTracks().forEach((track) => track.stop());
    this.setSnapshot({ localStream: null });
  }

  async connect(): Promise<void> {
    if (this.snapshot.state === "connecting" || this.snapshot.state === "live") return;
    const attempt = ++this.attempt;
    const aborted = new Promise<never>((_, reject) => {
      this.abortConnect = reject;
    });
    aborted.catch(() => {});
    const race = <T>(promise: Promise<T>) => Promise.race([promise, aborted]);
    this.billedSeconds = 0;
    this.endedReason = null;
    this.lastQueue = "";
    this.trackKindsSeen = new Set();
    this.setSnapshot({ state: "connecting", error: null, remoteStream: null, networkQuality: "unknown" });

    try {
      await race(
        Promise.resolve(this.connectGuard?.({ endpoint: this.model })).catch((error: unknown) => {
          throw new UserFacingError(rawMessage(error));
        })
      );
      const localStream = this.snapshot.localStream ?? (await race(this.acquireLocalStream()));
      if (localStream !== this.snapshot.localStream) this.setSnapshot({ localStream });

      // Miko's own limit from the token request to "connected" (the SDK's own
      // connect timeout is 60 s, with retries). The first frame gets its own
      // limit once connected.
      this.steps = { attempt, startedAt: performance.now(), reached: new Map() };
      this.connectTimer = setTimeout(() => {
        this.abortConnect?.(new Error("timed out connecting"));
      }, DECART_CONNECT_TIMEOUT_MS);

      const token = await race(
        this.bridge.getToken(this.model).catch((error: unknown) => {
          throw new UserFacingError(rawMessage(error));
        })
      );
      this.mark(attempt, "token");

      let deliverVideo: (stream: MediaStream) => void = () => {};
      const video = new Promise<MediaStream>((resolve) => {
        deliverVideo = resolve;
      });
      const client = this.sdk.createDecartClient({ apiKey: token, telemetry: false });
      const connecting = client.realtime.connect(localStream, {
        model: this.sdk.models.realtime(this.model),
        // The SDK calls this again, with a new stream, each time a track
        // (audio or video) arrives from the service. Only the video is
        // shown, and always the newest video track: taking the first call
        // alone could mean an audio-only stream and a black result.
        onRemoteStream: (remote: MediaStream) => {
          if (attempt !== this.attempt) return;
          this.logTrackArrivals(remote);
          const [videoTrack] = remote.getVideoTracks();
          if (!videoTrack) return;
          if (this.snapshot.remoteStream?.getVideoTracks()[0] === videoTrack) return;
          // Video only: the result player isn't muted.
          const videoOnly = new MediaStream([videoTrack]);
          if (this.snapshot.state === "live") this.setSnapshot({ remoteStream: videoOnly });
          else deliverVideo(videoOnly);
        },
        onConnectionChange: (state: string) => this.handleConnectionChange(attempt, state),
        onConnectionQuality: (report: { quality?: string }) => this.handleQuality(attempt, report),
        onQueuePosition: (queue: { position?: number; queueSize?: number }) => this.handleQueue(attempt, queue),
        initialState: this.initialState()
      });
      // A connection that completes after Miko gave up must still be closed.
      connecting.then(
        (late) => {
          if (attempt !== this.attempt) this.safeDisconnect(late);
        },
        () => {}
      );
      const realtime = await race(connecting);
      this.client = realtime;
      this.mark(attempt, "connected");
      // Connected: now the first frame gets its own, longer, unbilled wait.
      this.clearConnectTimer();
      this.connectTimer = setTimeout(() => {
        this.abortConnect?.(new Error("timed out waiting for the first frame"));
      }, DECART_FIRST_FRAME_TIMEOUT_MS);
      realtime.on("error", (error: unknown) => this.fail(attempt, error));
      realtime.on("diagnostic", (event: { name?: string; data?: any }) => this.logDiagnostic(attempt, event));
      realtime.on("generationTick", (tick: { seconds?: number }) => {
        if (Number.isFinite(tick?.seconds)) this.billedSeconds = Number(tick.seconds);
      });
      realtime.on("generationEnded", (ended: { seconds?: number; reason?: string }) => {
        if (Number.isFinite(ended?.seconds)) this.billedSeconds = Number(ended.seconds);
        this.endedReason = typeof ended?.reason === "string" ? ended.reason : "ended";
        if (attempt === this.attempt && this.snapshot.state === "live") this.fail(attempt, new SessionEnded(this.endedReason));
      });

      const remote = await race(video);
      this.mark(attempt, "video");
      this.clearConnectTimer();
      this.abortConnect = null;
      this.lastPushed = this.editKey();
      this.logTiming(attempt, "connected");
      this.setSnapshot({ state: "live", error: null, remoteStream: remote });
    } catch (error) {
      // disconnect() moved on to a new attempt: nothing to report.
      if (attempt !== this.attempt) return;
      this.finishWithError(attempt, error);
    }
  }

  disconnect() {
    this.attempt += 1;
    this.abortConnect?.(new Error("cancelled"));
    this.teardown();
    this.setSnapshot({ state: "idle", error: null, remoteStream: null });
  }

  /** Stops the session and releases the camera (disconnect() keeps previewing). */
  hardStop() {
    this.disconnect();
    this.stopPreview();
  }

  // ---------------------------------------------------------------------

  private setSnapshot(patch: Partial<DecartSnapshot>) {
    this.snapshot = { ...this.snapshot, ...patch };
    for (const listener of this.listeners) listener();
  }

  private async restartPreview(): Promise<void> {
    if (!this.snapshot.localStream) return;
    if (this.snapshot.state !== "idle" && this.snapshot.state !== "error") return;
    this.snapshot.localStream.getTracks().forEach((track) => track.stop());
    this.setSnapshot({ localStream: null });
    await this.previewCamera();
  }

  private acquireLocalStream(): Promise<MediaStream> {
    return navigator.mediaDevices.getUserMedia({
      video: {
        width: { ideal: CAPTURE_WIDTH },
        height: { ideal: CAPTURE_HEIGHT },
        aspectRatio: CAPTURE_WIDTH / CAPTURE_HEIGHT,
        frameRate: { ideal: 30, max: 30 },
        deviceId: this.preferredDeviceId ? { exact: this.preferredDeviceId } : undefined
      },
      audio: false
    });
  }

  private initialState() {
    const { prompt, referenceImageUrl, enablePromptExpansion } = this.editParams;
    return {
      ...(prompt ? { prompt: { text: prompt, enhance: enablePromptExpansion !== false } } : {}),
      ...(referenceImageUrl ? { image: referenceImageUrl } : {})
    };
  }

  // set() replaces the whole session state, so prompt and image always go
  // together.
  private editKey(): string {
    const { prompt, referenceImageUrl, enablePromptExpansion } = this.editParams;
    return JSON.stringify([prompt ?? "", referenceImageUrl ?? "", enablePromptExpansion !== false]);
  }

  private schedulePush() {
    if (this.pushTimer) clearTimeout(this.pushTimer);
    this.pushTimer = setTimeout(() => {
      this.pushTimer = null;
      const client = this.client;
      const key = this.editKey();
      if (!client || this.snapshot.state !== "live" || key === this.lastPushed) return;
      this.lastPushed = key;
      const { prompt, referenceImageUrl, enablePromptExpansion } = this.editParams;
      client
        .set({
          ...(prompt ? { prompt } : {}),
          ...(referenceImageUrl ? { image: referenceImageUrl } : {}),
          enhance: enablePromptExpansion !== false
        })
        .catch((error: unknown) => {
          this.lastPushed = "";
          this.bridge.logEvent?.("warn", `The prompt or reference image update wasn't applied: ${rawMessage(error)}`);
        });
    }, EDIT_PUSH_DELAY_MS);
  }

  private handleConnectionChange(attempt: number, state: string) {
    if (attempt !== this.attempt) return;
    if (state === "generating") this.mark(attempt, "generating");
    if (state === "reconnecting") {
      this.fail(attempt, new ConnectionDropped("reconnecting"));
    } else if (state === "disconnected" && (this.snapshot.state === "live" || this.snapshot.state === "connecting")) {
      this.fail(attempt, this.endedReason ? new SessionEnded(this.endedReason) : new ConnectionDropped("disconnected"));
    }
  }

  private handleQueue(attempt: number, queue: { position?: number; queueSize?: number }) {
    if (attempt !== this.attempt || !Number.isFinite(queue?.position)) return;
    const key = `${queue.position}/${queue.queueSize}`;
    if (key === this.lastQueue) return;
    this.lastQueue = key;
    this.bridge.logEvent?.("info", `Waiting for a free slot on the service: position ${queue.position} of ${queue.queueSize ?? "?"}`);
  }

  // Step names and durations only, never payload details such as addresses.
  private logDiagnostic(attempt: number, event: { name?: string; data?: any }) {
    if (attempt !== this.attempt || !event?.name) return;
    if (event.name === "client-session-connection-breakdown") {
      const phases = Array.isArray(event.data?.phases)
        ? event.data.phases
            .map((phase: { phase?: string; durationMs?: number; success?: boolean }) => `${phase.phase} ${Math.round(phase.durationMs ?? 0)} ms${phase.success === false ? " (failed)" : ""}`)
            .join(" · ")
        : "";
      this.bridge.logEvent?.("info", `Service connection steps: ${phases || "none reported"}`);
    } else if (event.name === "videoStall") {
      this.bridge.logEvent?.(
        "warn",
        event.data?.stalled ? "Output video stalled" : `Output video resumed after ${Math.round(event.data?.durationMs ?? 0)} ms`
      );
    }
  }

  // One line the first time each kind of output track arrives.
  private logTrackArrivals(remote: MediaStream) {
    const elapsed = this.steps ? ` after ${((performance.now() - this.steps.startedAt) / 1000).toFixed(1)}s` : "";
    for (const track of remote.getTracks()) {
      if (this.trackKindsSeen.has(track.kind)) continue;
      this.trackKindsSeen.add(track.kind);
      this.bridge.logEvent?.("info", `Output ${track.kind} track arrived${elapsed}`);
    }
  }

  private handleQuality(attempt: number, report: { quality?: string }) {
    if (attempt !== this.attempt) return;
    const quality = report?.quality === "good" || report?.quality === "fair" ? report.quality : report?.quality ? "poor" : "unknown";
    if (quality !== this.snapshot.networkQuality) this.setSnapshot({ networkQuality: quality });
  }

  private fail(attempt: number, error: unknown) {
    if (attempt !== this.attempt) return;
    if (this.snapshot.state === "connecting" && this.abortConnect) {
      // connect()'s catch reports it.
      this.abortConnect(error instanceof Error ? error : new Error(String(error)));
      return;
    }
    this.finishWithError(attempt, error);
  }

  private finishWithError(attempt: number, error: unknown) {
    this.attempt += 1;
    this.logTiming(attempt, "failed", rawMessage(error) || (error as Error)?.constructor?.name);
    this.teardown();
    this.setSnapshot({ state: "error", error: this.describeError(error), remoteStream: null });
  }

  private teardown() {
    this.clearConnectTimer();
    if (this.pushTimer) {
      clearTimeout(this.pushTimer);
      this.pushTimer = null;
    }
    this.abortConnect = null;
    const client = this.client;
    this.client = null;
    if (client) this.safeDisconnect(client);
    if (this.billedSeconds > 0) {
      this.bridge.logEvent?.("info", `The service reported ${Math.round(this.billedSeconds)} s of generation for this session`);
    }
  }

  private safeDisconnect(client: DecartRealtimeClient) {
    try {
      client.disconnect();
    } catch (error) {
      console.warn("[decart] disconnect failed:", rawMessage(error));
    }
  }

  private clearConnectTimer() {
    if (this.connectTimer) {
      clearTimeout(this.connectTimer);
      this.connectTimer = null;
    }
  }

  private describeError(error: unknown): string {
    if (error instanceof UserFacingError) return error.message;
    if (error instanceof ConnectionDropped) {
      return "The connection dropped, so Miko stopped the session instead of reconnecting in the background (every attempt is billed). Press Start to connect again.";
    }
    if (error instanceof SessionEnded) {
      return /duration|limit|max/i.test(error.message)
        ? "The session reached its 10-minute limit, so the service ended it. Press Start to continue."
        : `The service ended the session (${error.message}). Press Start to connect again.`;
    }
    const raw = rawMessage(error);
    if (raw === "timed out connecting") {
      return `The live session didn't connect within ${DECART_CONNECT_TIMEOUT_MS / 1000}s, so it was stopped. This can be your network, a VPN or firewall blocking the video connection, or the service responding slowly. Try again, and check your connection if it keeps happening.`;
    }
    if (raw === "timed out waiting for the first frame") {
      return `The session connected, but the first swapped frame didn't arrive within ${DECART_FIRST_FRAME_TIMEOUT_MS / 1000}s, so Miko stopped it. The service may be busy; try again in a moment.`;
    }
    const code = (error as { code?: string })?.code;
    if (code === "INVALID_API_KEY" || /invalid (or expired )?api key|unauthori[sz]ed/i.test(raw)) {
      return "The API key was rejected. Check it in Model settings → API key.";
    }
    if (code === "WEB_RTC_ERROR") {
      return "The live video connection failed. A VPN, proxy or firewall may be blocking it (it needs UDP port 7882). Turn those off or switch networks, then press Start.";
    }
    if (code === "MODEL_NOT_FOUND") return "This model isn't available to this account.";
    if (code === "INVALID_INPUT") return `The prompt or reference image was rejected: ${raw}`;
    const name = (error as { name?: string })?.name;
    if (name === "NotAllowedError" || name === "SecurityError") return "Camera access is blocked. Allow Miko to use the camera, then press Start.";
    if (name === "NotFoundError") return "No camera was found. Connect one, then press Start.";
    if (name === "NotReadableError") return "The camera is being used by another app. Close it, then press Start.";
    if (name === "OverconstrainedError") return "The selected camera can't provide 1280×720 video. Choose another camera.";
    return raw ? `Could not start the live session: ${raw}` : "Could not start the live session.";
  }

  private mark(attempt: number, step: Step) {
    const record = this.steps;
    if (!record || record.attempt !== attempt || record.reached.has(step)) return;
    record.reached.set(step, performance.now() - record.startedAt);
  }

  // Same one-line format as the fal session, so both can be read the same way.
  private logTiming(attempt: number, outcome: "connected" | "failed", reason?: string) {
    const record = this.steps;
    if (!record || record.attempt !== attempt) return;
    this.steps = null;
    const seconds = (ms: number) => `${(ms / 1000).toFixed(1)}s`;
    const steps =
      STEP_ORDER.filter((step) => record.reached.has(step))
        .map((step) => `${step} ${seconds(record.reached.get(step) ?? 0)}`)
        .join(" · ") || "no step reached";
    const total = seconds(performance.now() - record.startedAt);
    if (outcome === "connected") {
      this.bridge.logEvent?.("info", `Connected in ${total} — ${steps}`);
      return;
    }
    const waitingOn = STEP_ORDER.find((step) => !record.reached.has(step));
    this.bridge.logEvent?.(
      "warn",
      `Connect failed after ${total} — ${steps}${waitingOn ? ` · waiting on: ${waitingOn}` : ""}${reason ? ` (${reason})` : ""}`
    );
  }
}

let activeSession: DecartRealtimeSession | null = null;
let globalHandlersRegistered = false;

function registerGlobalTeardownHandlers() {
  if (globalHandlersRegistered || typeof window === "undefined") return;
  globalHandlersRegistered = true;
  const stop = () => activeSession?.hardStop();
  window.addEventListener("pagehide", stop);
  window.addEventListener("beforeunload", stop);
}

/** The single Decart session; switching models closes the previous one first. */
export function getDecartSession(model: string, sdk: DecartSdk, bridge: DecartBridge): DecartRealtimeSession {
  registerGlobalTeardownHandlers();
  if (activeSession && activeSession.getEndpoint() !== model) {
    activeSession.hardStop();
    activeSession = null;
  }
  if (!activeSession) activeSession = new DecartRealtimeSession(model, sdk, bridge);
  return activeSession;
}
