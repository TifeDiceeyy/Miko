const test = require("node:test");
const assert = require("node:assert/strict");
const { computeReferenceSize } = require("../lib/reference-policy");

test("caps ordinary references at 1280px", () => {
  const result = computeReferenceSize(4000, 3000);
  assert.deepEqual([result.width, result.height], [1280, 960]);
});

test("center-crops extreme panoramas so the short edge remains usable", () => {
  const result = computeReferenceSize(3000, 800);
  assert.deepEqual([result.width, result.height], [1280, 640]);
  assert.equal(result.sourceWidth, 1600);
  assert.equal(result.sourceX, 700);
});

test("leaves an already suitable 600px square unchanged", () => {
  const result = computeReferenceSize(600, 600);
  assert.deepEqual([result.width, result.height], [600, 600]);
});
