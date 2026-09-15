// Decart's REST API, used by the main process only: the real key never
// reaches the renderer. The renderer gets a short-lived client token scoped
// to one model, carrying Decart's own cap on how long a session may run —
// Decart has no balance API, so that cap is a billing safety net.
const API_BASE = "https://api.decart.ai";
// The two models Miko uses (see DECART_MODELS in lib/session-presets.js).
const DECART_MODELS = Object.freeze(["lucy-2.5", "lucy-vton-3.5"]);
// Only needs to last until the session connects; an expiring token blocks
// new connections but doesn't end a live session.
const TOKEN_LIFETIME_SECONDS = 60;
const MAX_SESSION_SECONDS = 10 * 60;

function networkError(error, action) {
  const cause = error?.cause ? `: ${error.cause.code || error.cause.message || error.cause}` : error?.message ? `: ${error.message}` : "";
  return new Error(`Could not reach the realtime service to ${action} (network error${cause}).`);
}

async function readDetail(response) {
  const text = await response.text().catch(() => "");
  try {
    const data = JSON.parse(text);
    if (typeof data?.error === "string") return data.error;
    if (typeof data?.detail === "string") return data.detail;
    if (Array.isArray(data?.detail)) return data.detail.map((entry) => entry?.msg).filter(Boolean).join("; ") || text;
    if (typeof data?.message === "string") return data.message;
  } catch {}
  return text.slice(0, 300);
}

// User-facing and precise, without naming the supplier (the UI says "Miko").
async function failure(response, action) {
  const status = response.status;
  const detail = await readDetail(response);
  const suffix = detail ? ` (${status}: ${detail})` : ` (${status})`;
  let message;
  if (status === 401 || status === 403) message = `The API key was rejected${suffix}. Check it in Model settings → API key.`;
  else if (status === 402 || /insufficient|credits?\b|balance|payment/i.test(detail)) message = `The account has run out of credits${suffix}. Add credits, then try again.`;
  else if (status === 429) message = `The account is being rate limited${suffix}. Wait a moment, then try again.`;
  else if (status >= 500) message = `The realtime service had an error${suffix}. Try again in a moment.`;
  else message = `The realtime service refused to ${action}${suffix}.`;
  const error = new Error(message);
  error.status = status;
  return error;
}

async function createClientToken({
  apiKey,
  model,
  fetchImpl = fetch,
  expiresInSeconds = TOKEN_LIFETIME_SECONDS,
  maxSessionSeconds = MAX_SESSION_SECONDS
}) {
  if (!DECART_MODELS.includes(model)) throw new Error(`Miko doesn't use the model "${model}".`);
  if (!apiKey) throw new Error("No API key configured. Add one in Model settings → API key.");
  let response;
  try {
    response = await fetchImpl(`${API_BASE}/v1/client/tokens`, {
      method: "POST",
      headers: { "x-api-key": apiKey, "content-type": "application/json", accept: "application/json" },
      body: JSON.stringify({
        expiresIn: expiresInSeconds,
        allowedModels: [model],
        constraints: { realtime: { maxSessionDuration: maxSessionSeconds } }
      })
    });
  } catch (error) {
    throw networkError(error, "request a session token");
  }
  if (!response.ok) throw await failure(response, "issue a session token");
  let data;
  try {
    data = await response.json();
  } catch (error) {
    throw new Error(`The realtime service returned an unreadable token response: ${error.message}`);
  }
  if (!data || typeof data.apiKey !== "string" || !data.apiKey) {
    throw new Error("The realtime service's token response had no token in it.");
  }
  return { token: data.apiKey, expiresAt: typeof data.expiresAt === "string" ? data.expiresAt : null };
}

// How many live sessions the account may run at once, and how many are
// running now. Not a balance: Decart doesn't report one.
async function getRealtimeQuota({ apiKey, fetchImpl = fetch }) {
  if (!apiKey) throw new Error("No API key configured. Add one in Model settings → API key.");
  let response;
  try {
    response = await fetchImpl(`${API_BASE}/v1/realtime/quota`, { headers: { "x-api-key": apiKey, accept: "application/json" } });
  } catch (error) {
    throw networkError(error, "check the live-session limit");
  }
  if (!response.ok) throw await failure(response, "report the live-session limit");
  const data = await response.json().catch(() => ({}));
  const number = (value) => (Number.isFinite(value) ? value : null);
  return { limit: number(data?.limit), active: number(data?.active), remaining: number(data?.remaining) };
}

module.exports = {
  API_BASE,
  DECART_MODELS,
  MAX_SESSION_SECONDS,
  TOKEN_LIFETIME_SECONDS,
  createClientToken,
  getRealtimeQuota
};
