const test = require("node:test");
const assert = require("node:assert/strict");
const presets = require("../lib/session-presets");
const billing = require("../lib/billing-policy");

const { pro: PRO, lite: LITE } = presets.MODELS;

test("migrates legacy mode-only settings to model + task", () => {
  assert.deepEqual(presets.resolveSelection({ mode: LITE }), { model: LITE, task: "outfit" });
  assert.deepEqual(presets.resolveSelection({ mode: PRO }), { model: PRO, task: "character" });
});

test("keeps an explicit model + task, including Lite with a full character swap", () => {
  assert.deepEqual(presets.resolveSelection({ model: LITE, task: "character", mode: LITE }), { model: LITE, task: "character" });
  assert.deepEqual(presets.resolveSelection({ model: PRO, task: "outfit" }), { model: PRO, task: "outfit" });
});

test("falls back to Pro + full character swap for missing or invalid values", () => {
  assert.deepEqual(presets.resolveSelection(null), { model: PRO, task: "character" });
  assert.deepEqual(presets.resolveSelection({ model: "someone/else", task: "anything" }), { model: PRO, task: "character" });
});

test("a task change swaps the prompt only when it is the untouched default", () => {
  const { character, outfit } = presets.DEFAULT_PROMPTS;
  assert.equal(presets.promptAfterTaskChange(character, "character", "outfit"), outfit);
  assert.equal(presets.promptAfterTaskChange(outfit, "outfit", "character"), character);
  assert.equal(presets.promptAfterTaskChange("my own prompt", "character", "outfit"), "my own prompt");
});

test("every model has a verified rate, and Lite gives twice Pro's runway", () => {
  for (const model of Object.values(presets.MODELS)) assert.ok(billing.rateForEndpoint(model) > 0);
  assert.equal(billing.secondsUntilFloor(3, LITE), 2 * billing.secondsUntilFloor(3, PRO));
});

test("the rate follows the model, whatever the task", () => {
  const meter = new billing.BillingMeter();
  meter.observeBalance(5);
  meter.recordSpend(10, LITE);
  assert.ok(Math.abs(meter.effectiveBalance() - 4.8) < 1e-9);
  meter.recordSpend(10, PRO);
  assert.ok(Math.abs(meter.effectiveBalance() - 4.4) < 1e-9);
});
