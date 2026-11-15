// Pure fit logic, shared by the browser and the tests.
// All maths in whole millimetres so 180.0 cm against a 180 cm wall is an exact fit.
export const mm = (cm) => Math.round(Number(cm) * 10);

const SOLD = new Set(["out_of_stock", "discontinued"]);

// space: { widthCm, depthCm, gapCm }  slots: [{ kind }]  products: normalized products
// Items stand side by side along one straight wall:
//   sum(width) + (n - 1) * gap <= wall width   and   max(depth) <= corner depth
export function findCombos(space, slots, products) {
  const width = mm(space.widthCm);
  const depth = mm(space.depthCm);
  const gap = mm(space.gapCm);
  const pools = slots.map((slot) => products.filter((p) =>
    p.kind === slot.kind && p.widthMm > 0 && p.depthMm > 0 && !SOLD.has(p.availability)));
  const combos = [];
  const seen = new Set();
  let nearestOverMm = null;
  let tooDeep = 0;

  const walk = (index, items, used) => {
    if (index < pools.length) {
      for (const p of pools[index]) {
        if (items.some((chosen) => chosen.id === p.id)) continue;
        walk(index + 1, [...items, p], used + p.widthMm + (index ? gap : 0));
      }
      return;
    }
    const maxDepthMm = Math.max(...items.map((p) => p.depthMm));
    if (maxDepthMm > depth) {
      tooDeep++;
      return;
    }
    if (used > width) {
      nearestOverMm = nearestOverMm === null ? used - width : Math.min(nearestOverMm, used - width);
      return;
    }
    const key = items.map((p) => p.id).sort().join(" + ");
    if (seen.has(key)) return;
    seen.add(key);
    combos.push({ id: items.map((p) => p.id).join(" + "), items, usedMm: used, freeMm: width - used, maxDepthMm });
  };

  if (Number.isFinite(width) && width > 0 && Number.isFinite(depth) && depth > 0 && gap >= 0 &&
      pools.length && pools.every((pool) => pool.length)) walk(0, [], 0);
  // Tightest fit first, then a stable order.
  combos.sort((a, b) => a.freeMm - b.freeMm || a.id.localeCompare(b.id));
  return { combos, nearestOverMm, tooDeep, poolSizes: pools.map((pool) => pool.length) };
}
