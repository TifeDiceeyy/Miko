(function exposeBillingPolicy(root, factory) {
  const policy = factory();
  if (typeof module === "object" && module.exports) module.exports = policy;
  if (root) root.MikoBillingPolicy = policy;
})(typeof globalThis === "undefined" ? undefined : globalThis, function createBillingPolicy() {
  const MIN_BALANCE_USD = 1;
  const MAX_PERSIST_AGE_MS = 15 * 60 * 1000;
  const RATE_PER_SECOND = Object.freeze({
    "decart/lucy-2-5/realtime": 0.04,
    "decart/lucy2-vton/realtime": 0.02,
    // Decart direct (its pricing page, checked 2026-09-15), billed per second
    // of active generation.
    "lucy-2.5": 0.02,
    "lucy-vton-3.5": 0.02
  });

  function rateForEndpoint(endpoint) {
    const rate = RATE_PER_SECOND[endpoint];
    if (!rate) throw new Error(`No verified billing rate for endpoint: ${endpoint}`);
    return rate;
  }

  function canStart(balance) {
    return Number.isFinite(balance) && balance > MIN_BALANCE_USD;
  }

  function secondsUntilFloor(balance, endpoint) {
    if (!Number.isFinite(balance)) return 0;
    return Math.max(0, (balance - MIN_BALANCE_USD) / rateForEndpoint(endpoint));
  }

  function estimatedBalance(balanceAtSync, syncedAtMs, nowMs, endpoint) {
    const elapsedSeconds = Math.max(0, nowMs - syncedAtMs) / 1000;
    return balanceAtSync - elapsedSeconds * rateForEndpoint(endpoint);
  }

  class BillingMeter {
    constructor({ storage = null, now = () => Date.now() } = {}) {
      this.storage = storage;
      this.now = now;
      this.trusted = null;
      this.unposted = 0;
      this.lastObservedAt = null;
      this.restore();
    }

    restore() {
      if (!this.storage) return;
      try {
        const saved = JSON.parse(this.storage.getItem("miko.billing-meter") || "null");
        if (!saved || this.now() - saved.savedAt > MAX_PERSIST_AGE_MS) return;
        if (Number.isFinite(saved.trusted) && Number.isFinite(saved.unposted)) {
          this.trusted = saved.trusted;
          this.unposted = Math.max(0, saved.unposted);
          this.lastObservedAt = Number.isFinite(saved.observedAt) ? saved.observedAt : saved.savedAt;
        }
      } catch {}
    }

    // True when a real balance reading is recent enough to start on if the
    // billing service is briefly unreachable; the local meter still subtracts
    // everything spent since that reading.
    hasRecentBalance(maxAgeMs = MAX_PERSIST_AGE_MS) {
      return this.trusted != null && this.lastObservedAt != null && this.now() - this.lastObservedAt <= maxAgeMs;
    }

    minutesSinceObserved() {
      return this.lastObservedAt == null ? null : Math.max(0, Math.round((this.now() - this.lastObservedAt) / 60000));
    }

    persist() {
      if (!this.storage || this.trusted == null) return;
      try {
        this.storage.setItem("miko.billing-meter", JSON.stringify({
          trusted: this.trusted,
          unposted: this.unposted,
          observedAt: this.lastObservedAt,
          savedAt: this.now()
        }));
      } catch {}
    }

    observeBalance(balance) {
      if (!Number.isFinite(balance)) return;
      this.lastObservedAt = this.now();
      if (this.trusted == null) {
        this.trusted = balance;
      } else if (balance < this.trusted - 0.005) {
        const postedDrop = this.trusted - balance;
        this.unposted = Math.max(0, this.unposted - postedDrop);
        this.trusted = balance;
      } else if (balance > this.trusted + 0.005) {
        // A real top-up can raise the trusted balance, while unposted local
        // spend remains reserved until the provider posts it.
        this.trusted = balance;
      }
      this.persist();
    }

    recordSpend(seconds, endpoint) {
      if (this.trusted == null || !Number.isFinite(seconds) || seconds <= 0) return;
      this.unposted += seconds * rateForEndpoint(endpoint);
      this.persist();
    }

    effectiveBalance() {
      return this.trusted == null ? null : Math.max(0, this.trusted - this.unposted);
    }

    remainingSeconds(endpoint) {
      const effective = this.effectiveBalance();
      return effective == null ? null : Math.floor(secondsUntilFloor(effective, endpoint));
    }

    hasUnpostedSpend() {
      return this.unposted > 0.0001;
    }
  }

  // The Decart daily limit as typed: empty or invalid (including negative)
  // means the default, exactly 0 means no limit, and it's capped at $1000.
  function parseDailyLimit(value, fallback = 5) {
    if (value === undefined || value === null || String(value).trim() === "") return fallback;
    const number = Number(value);
    if (!Number.isFinite(number) || number < 0) return fallback;
    return Math.min(1000, Math.round(number * 100) / 100);
  }

  // Decart reports no balance, so Miko keeps its own total of today's spend
  // with it (by local date) and stops sessions at the owner's daily limit.
  class DailySpend {
    constructor({ storage = null, now = () => Date.now(), key = "miko.decart-daily-spend" } = {}) {
      this.storage = storage;
      this.now = now;
      this.key = key;
    }

    dateKey() {
      const date = new Date(this.now());
      return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
    }

    today() {
      try {
        const saved = JSON.parse(this.storage?.getItem(this.key) || "null");
        return saved && saved.date === this.dateKey() && Number.isFinite(saved.usd) ? saved.usd : 0;
      } catch {
        return 0;
      }
    }

    add(usd) {
      if (!Number.isFinite(usd) || usd <= 0) return;
      try {
        this.storage?.setItem(this.key, JSON.stringify({ date: this.dateKey(), usd: this.today() + usd }));
      } catch {}
    }

    // Whole seconds left under the limit at this model's rate; Infinity when
    // there's no limit (0).
    remainingSeconds(limitUsd, model) {
      if (!(limitUsd > 0)) return Infinity;
      return Math.max(0, Math.floor((limitUsd - this.today()) / rateForEndpoint(model)));
    }
  }

  return Object.freeze({
    MIN_BALANCE_USD,
    BillingMeter,
    DailySpend,
    parseDailyLimit,
    MAX_PERSIST_AGE_MS,
    RATE_PER_SECOND,
    canStart,
    estimatedBalance,
    rateForEndpoint,
    secondsUntilFloor
  });
});
