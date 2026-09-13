export {};

declare global {
  interface Window {
    deepLiveCam: {
      appInfo(): Promise<{ version: string; platform: string; architecture: string }>;
      pickMedia(kind: "image" | "video"): Promise<{ name: string; path: string; url: string } | null>;
      loadSettings(): Promise<Record<string, unknown> | null>;
      saveSettings(settings: Record<string, unknown>): Promise<{ ok: boolean; settings?: unknown; message?: string }>;
      windowControl(action: "minimize" | "maximize" | "close"): Promise<boolean>;
      getKeyStatus(): Promise<{ hasKey: boolean }>;
      getBalance(): Promise<{ balance: number; currency: string } | null>;
      saveKey(key: string): Promise<{ hasKey: boolean }>;
      getToken(app: string): Promise<string>;
      openExternal(url: string): Promise<void>;
      obsStart(port?: number): Promise<{ url: string }>;
      obsStop(): Promise<void>;
      obsStatus(): Promise<{ running: boolean; url?: string }>;
      obsSendFrame(buffer: ArrayBuffer): void;
      obsClearFrame(): void;
    };
  }
}
