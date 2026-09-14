export {};

declare global {
  interface Window {
    deepLiveCam: {
      appInfo(): Promise<{ version: string; platform: string; architecture: string }>;
      logEvent(level: "info" | "warn" | "error", message: string): void;
      onSystemSuspend(callback: (reason: string) => void): () => void;
      getCameraAccess(): Promise<string>;
      checkConnection(): Promise<{
        reachable: boolean;
        blockers: { kind: string; message: string }[];
        warnings: { kind: string; message: string; label?: string | null }[];
        signature: string;
        typicalConnectMs: number | null;
      }>;
      openCameraSettings(): Promise<boolean>;
      openLogsFolder(): Promise<boolean>;
      pickMedia(kind: "image" | "video"): Promise<{ name: string; path: string; url: string } | null>;
      loadSettings(): Promise<Record<string, unknown> | null>;
      saveSettings(settings: Record<string, unknown>): Promise<{ ok: boolean; settings?: unknown; message?: string }>;
      windowControl(action: "minimize" | "maximize" | "close"): Promise<boolean>;
      getKeyStatus(): Promise<{ hasKey: boolean }>;
      getBalance(): Promise<{ balance: number; currency: string } | null>;
      saveKey(key: string): Promise<{ hasKey: boolean }>;
      getToken(app: string): Promise<string>;
      deleteRequestPayload(requestId: string): Promise<{ ok: boolean }>;
      openExternal(url: string): Promise<void>;
      obsStart(): Promise<{ url: string; port: number; preferredPort: number; file: string }>;
      obsStop(): Promise<void>;
      obsStatus(): Promise<{ running: boolean; url?: string; file?: string }>;
      obsRevealFile(): Promise<string | null>;
      setObsEnabled(enabled: boolean): Promise<void>;
      obsSendFrame(buffer: ArrayBuffer): void;
      obsClearFrame(): void;
    };
  }
}
