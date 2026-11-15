import test from "node:test";
import assert from "node:assert/strict";
import { findCombos } from "../public/fit.mjs";

const P = (id, kind, widthMm, depthMm, extra = {}) => ({ id, kind, widthMm, depthMm, availability: "in_stock", ...extra });
const besta = P("besta", "cabinet", 1200, 400);
const nybo = P("nybo", "table", 550, 550);
const randerup = P("randerup", "table", 470, 470);
const slots = [{ kind: "cabinet" }, { kind: "table" }];
const run = (widthCm, products = [besta, nybo, randerup], depthCm = 60) =>
  findCombos({ widthCm, depthCm, gapCm: 5 }, slots, products);
const ids = (result) => result.combos.map((combo) => combo.id);

test("179 cm wall: 120 + 47 + 5 = 172 fits, 120 + 55 + 5 = 180 does not", () => {
  const result = run(179);
  assert.deepEqual(ids(result), ["besta + randerup"]);
  assert.equal(result.combos[0].freeMm, 70);
  assert.equal(result.nearestOverMm, 10);
});

test("180 cm wall: an exact fit is allowed", () => {
  const result = run(180);
  assert.deepEqual(ids(result), ["besta + nybo", "besta + randerup"]);
  assert.equal(result.combos[0].freeMm, 0);
});

test("181 cm wall leaves 1 cm for the NYBO set", () => {
  assert.equal(run(181).combos.find((combo) => combo.id === "besta + nybo").freeMm, 10);
});

test("1 mm too wide is rejected", () => {
  assert.deepEqual(ids(run(179.9)), ["besta + randerup"]);
});

test("an item deeper than the corner is rejected even when the width fits", () => {
  const deep = P("deep", "table", 300, 610);
  const result = run(300, [besta, deep]);
  assert.deepEqual(ids(result), []);
  assert.equal(result.tooDeep, 1);
});

test("out of stock and dimensionless products are ignored", () => {
  const sold = P("sold", "table", 300, 300, { availability: "out_of_stock" });
  const unknown = P("unknown", "table", null, null);
  assert.deepEqual(ids(run(300, [besta, sold, unknown])), []);
});

test("two slots of the same kind do not produce mirrored duplicates", () => {
  const result = findCombos({ widthCm: 200, depthCm: 60, gapCm: 5 }, [{ kind: "table" }, { kind: "table" }], [nybo, randerup]);
  assert.equal(result.combos.length, 1);
});
