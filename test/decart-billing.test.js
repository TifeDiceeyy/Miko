const test = require("node:test");
const assert = require("node:assert/strict");
const presets = require("../lib/session-presets");
const billing = require("../lib/billing-policy");

test("each supplier runs its own model for Miko Pro and Miko Lite", () => {
  assert.equal(presets.resolveSupplier(undefined), "fal", "installs from before Decart support stay on fal");
  assert.equal(presets.resolveSupplier("anything"), "fal");
  assert.equal(presets.resolveSupplier("decart"), "decart");

  assert.equal(presets.backendModel(presets.MODELS.pro, "fal"), "decart/lucy-2-5/realtime");
  assert.equal(presets.backendModel(presets.MODELS.lite, "fal"), "decart/lucy2-vton/realtime");
  assert.equal(presets.backendModel(presets.MODELS.pro, "decart"), "lucy-2.5");
  assert.equal(presets.backendModel(presets.MODELS.lite, "decart"), "lucy-vton-3.5");
});

test("Decart's rates are half of fal's for the swap, the same for outfits", () => {
  assert.equal(billing.rateForEndpoint("lucy-2.5"), 0.02);
  assert.equal(billing.rateForEndpoint("lucy-vton-3.5"), 0.02);
  assert.equal(billing.rateForEndpoint("decart/lucy-2-5/realtime"), 0.04, "fal unchanged");
  assert.throws(() => billing.rateForEndpoint("lucy-latest"), /No verified billing rate/);
});

function memoryStorage() {
  const data = new Map();
  return { getItem: (key) => data.get(key) ?? null, setItem: (key, value) => data.set(key, String(value)) };
}

test("today's Decart spend adds up, resets the next day, and counts down the daily limit", () => {
  let now = new Date(2026, 8, 15, 9, 0, 0).getTime();
  const storage = memoryStorage();
  const spend = new billing.DailySpend({ storage, now: () => now });

  assert.equal(spend.today(), 0);
  spend.add(1.5);
  spend.add(0.5);
  spend.add(-3);
  spend.add(Number.NaN);
  assert.equal(spend.today(), 2);
  assert.equal(new billing.DailySpend({ storage, now: () => now }).today(), 2, "kept across restarts");

  assert.equal(spend.remainingSeconds(5, "lucy-2.5"), 150, "$3 left at $0.02/s");
  assert.equal(spend.remainingSeconds(0, "lucy-2.5"), Infinity, "0 means no limit");
  spend.add(3);
  assert.equal(spend.remainingSeconds(5, "lucy-2.5"), 0);

  now = new Date(2026, 8, 16, 0, 0, 1).getTime();
  assert.equal(spend.today(), 0, "a new day starts from zero");
});

test("the daily limit as typed: empty or invalid means the default, only 0 turns it off, capped at $1000", () => {
  assert.equal(billing.parseDailyLimit("", 5), 5);
  assert.equal(billing.parseDailyLimit(undefined, 5), 5);
  assert.equal(billing.parseDailyLimit("abc", 5), 5);
  assert.equal(billing.parseDailyLimit("-5", 5), 5, "a negative typo can't turn the limit off");
  assert.equal(billing.parseDailyLimit("0", 5), 0);
  assert.equal(billing.parseDailyLimit(0, 5), 0);
  assert.equal(billing.parseDailyLimit("7.25", 5), 7.25);
  assert.equal(billing.parseDailyLimit("5000", 5), 1000);
});
