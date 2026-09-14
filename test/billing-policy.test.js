const test = require("node:test");
const assert = require("node:assert/strict");
const billing = require("../lib/billing-policy");

const CHARACTER = "decart/lucy-2-5/realtime";
const VTON = "decart/lucy2-vton/realtime";

test("uses the verified rate for each realtime mode", () => {
  assert.equal(billing.rateForEndpoint(CHARACTER), 0.04);
  assert.equal(billing.rateForEndpoint(VTON), 0.02);
});

test("requires a balance strictly above the one-dollar floor", () => {
  assert.equal(billing.canStart(1), false);
  assert.equal(billing.canStart(1.0001), true);
  assert.equal(billing.canStart(null), false);
});

test("computes remaining paid seconds above the floor", () => {
  assert.equal(billing.secondsUntilFloor(2, CHARACTER), 25);
  assert.equal(billing.secondsUntilFloor(2, VTON), 50);
  assert.equal(billing.secondsUntilFloor(0.5, CHARACTER), 0);
});

test("estimates spend locally between balance cross-checks", () => {
  assert.equal(billing.estimatedBalance(5, 1000, 11000, CHARACTER), 4.6);
  assert.equal(billing.estimatedBalance(5, 1000, 11000, VTON), 4.8);
});

test("reconciles posted charges without forgetting unposted spend", () => {
  const meter = new billing.BillingMeter();
  meter.observeBalance(5);
  meter.recordSpend(10, CHARACTER);
  assert.equal(meter.effectiveBalance(), 4.6);
  meter.observeBalance(5);
  assert.equal(meter.effectiveBalance(), 4.6);
  meter.observeBalance(4.8);
  assert.ok(Math.abs(meter.effectiveBalance() - 4.6) < 1e-9);
  meter.observeBalance(4.6);
  assert.ok(Math.abs(meter.effectiveBalance() - 4.6) < 1e-9);
});

test("restores recent spend state and ignores state older than 15 minutes", () => {
  const values = new Map();
  const storage = {
    getItem: (key) => values.get(key) ?? null,
    setItem: (key, value) => values.set(key, value)
  };
  let now = 1000;
  const meter = new billing.BillingMeter({ storage, now: () => now });
  meter.observeBalance(3);
  meter.recordSpend(5, VTON);
  assert.equal(new billing.BillingMeter({ storage, now: () => now }).effectiveBalance(), 2.9);

  now += billing.MAX_PERSIST_AGE_MS + 1;
  assert.equal(new billing.BillingMeter({ storage, now: () => now }).effectiveBalance(), null);
});
