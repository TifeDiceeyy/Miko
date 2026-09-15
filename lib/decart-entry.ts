// Entry for dist/decart-session.bundle.js. app.js loads this bundle only
// when Decart is the key supplier (ensureDecartBundle() in app.js), so the
// fal bundle never includes or depends on it.
import { createDecartClient, models } from "@decartai/sdk";
import { DECART_CONNECT_TIMEOUT_MS, getDecartSession, type DecartSdk } from "./decart-realtime-session";

const sdk = { createDecartClient, models } as unknown as DecartSdk;

(window as unknown as { MikoDecart: unknown }).MikoDecart = {
  CONNECT_TIMEOUT_MS: DECART_CONNECT_TIMEOUT_MS,
  getSession: (model: string) =>
    getDecartSession(model, sdk, {
      getToken: (requested: string) => window.deepLiveCam.decartToken(requested),
      logEvent: (level, message) => window.deepLiveCam.logEvent(level, message)
    })
};
