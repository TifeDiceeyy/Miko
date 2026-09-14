(function exposeBillingPolicy(root, factory) {
  const policy = factory();
  if (typeof module === "object" && module.exports) module.exports = policy;
  if (root) root.MikoBillingPolicy = policy;
})(typeof globalThis === "undefined" ? undefined : globalThis, function createBillingPolicy() {
  const MIN_BALANCE_USD = 1;
  const MAX_PERSIST_AGE_MS = 15 * 60 * 1000;
  const RATE_PER_SECOND = Object.freeze({
    "decart/lucy-2-5/realtime": 0.04,
    "decart/lucy2-vton/realtime": 0.02
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

  return Object.freeze({
    MIN_BALANCE_USD,
    BillingMeter,
    MAX_PERSIST_AGE_MS,
    RATE_PER_SECOND,
    canStart,
    estimatedBalance,
    rateForEndpoint,
    secondsUntilFloor
  });
});
