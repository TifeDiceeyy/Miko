import { getLucySession } from "./lucy-realtime-session";
import { REALTIME_ENDPOINTS, RESOLUTION_STEPS, MIN_REFERENCE_IMAGE_DIMENSION } from "./lucy-config";

// app.js is plain JS with no bundler of its own, so this is the one seam
// where the TypeScript session logic (which needs @fal-ai/client bundled
// for the browser) gets exposed as a plain global for it to consume.
(window as unknown as { LucySession: unknown }).LucySession = {
  REALTIME_ENDPOINTS,
  RESOLUTION_STEPS,
  MIN_REFERENCE_IMAGE_DIMENSION,
  getSession: getLucySession,
};
