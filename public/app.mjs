import { findCombos } from "./fit.mjs";

const WATCH_MS = 60_000;          // auto re-check interval for watched sets
const WATCH_MAX_MS = 30 * 60_000; // stop watching after 30 min to protect credits

const $ = (id) => document.getElementById(id);
const esc = (value) => String(value ?? "").replace(/[&<>"']/g, (c) =>
  ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
const cm = (mmValue) => (mmValue / 10).toLocaleString("en", { maximumFractionDigits: 1 });
const clock = (iso) => new Date(iso).toLocaleTimeString("en-GB");
const seconds = (ms) => (ms / 1000).toFixed(1) + " s";
const https = (url) => (typeof url === "string" && url.startsWith("https://") ? url : "");
const stockLabel = (value) => (value ? value.replace(/_/g, " ") : "stock not stated");
function money(price, currency) {
  if (price == null) return "price not read";
  try {
    return new Intl.NumberFormat("en-IE", { style: "currency", currency: currency || "EUR" }).format(price);
  } catch {
    return price + " " + (currency || "");
  }
}
function age(ms) {
  const s = Math.round(ms / 1000);
  return s < 60 ? s + " s" : s < 3600 ? Math.round(s / 60) + " min" : Math.round(s / 3600) + " h";
}

const state = {
  kinds: { cabinet: "Low cabinet / TV bench", table: "Side table" },
  slots: ["cabinet", "table"],
  products: new Map(),
  combos: new Map(), // combo id -> product ids, rebuilt on every render
  stats: null,
  warnings: [],
  searchedSlots: null,
  run: 0,
  busy: false,
  error: "",
  mock: false,
  hasKey: true,
  limit: 8,
  rechecking: new Set(),
  watching: new Map(), // combo id -> { timer, ids, since }
  log: [],
};

function renderSlots() {
  $("slots").innerHTML = state.slots.map((kind, index) =>
    '<label>Item ' + (index + 1) + '<select data-slot="' + index + '">' +
    Object.entries(state.kinds).map(([id, label]) =>
      '<option value="' + esc(id) + '"' + (id === kind ? " selected" : "") + ">" + esc(label) + "</option>").join("") +
    "</select></label>").join("") +
    (state.slots.length > 1 ? '<button type="button" class="quiet" id="remove">Remove last item</button>' : "");
  $("add").disabled = state.slots.length >= 3;
}

function space() {
  return { widthCm: Number($("width").value), depthCm: Number($("depth").value), gapCm: Number($("gap").value) };
}

function diagram(combo, sp) {
  const scale = Math.min(460 / (sp.widthCm * 10), 120 / (sp.depthCm * 10));
  const w = sp.widthCm * 10 * scale;
  const h = sp.depthCm * 10 * scale;
  const left = (500 - w) / 2;
  const top = 8;
  let x = left;
  const colours = ["#738d75", "#a7b995", "#c1b88b"];
  const shapes = combo.items.map((item, index) => {
    const iw = item.widthMm * scale;
    const id = item.depthMm * scale;
    const shape = item.round
      ? '<circle cx="' + (x + iw / 2) + '" cy="' + (top + id / 2) + '" r="' + iw / 2 + '"'
      : '<rect x="' + x + '" y="' + top + '" width="' + iw + '" height="' + id + '" rx="2"';
    const label = '<text x="' + (x + iw / 2) + '" y="' + (top + id / 2 + 4) + '" text-anchor="middle" font-size="11" fill="#1f2a24">' + (index + 1) + "</text>";
    x += iw + sp.gapCm * 10 * scale;
    return shape + ' fill="' + colours[index % 3] + '" stroke="#516954" stroke-width="0.6"/>' + label;
  }).join("");
  return '<svg class="plan" role="img" aria-label="Scaled top view, wall at the top" viewBox="0 0 500 ' + (h + 30) + '">' +
    '<rect x="' + left + '" y="' + top + '" width="' + w + '" height="' + h + '" fill="#f1f4ec" stroke="#abb7a7"/>' +
    '<line x1="' + left + '" y1="' + top + '" x2="' + (left + w) + '" y2="' + top + '" stroke="#41584a" stroke-width="2.5"/>' +
    shapes + '<text x="250" y="' + (h + 24) + '" text-anchor="middle" font-size="11" fill="#5d6b62">' +
    cm(sp.widthCm * 10) + " × " + cm(sp.depthCm * 10) + " cm · wall at top · to scale</text></svg>";
}

function readLine(p) {
  const cached = p.cache?.status === "hit" && p.cache.ageMs > 0;
  const how = p.source === "mock" ? "mock data" : cached ? "cached copy, " + age(p.cache.ageMs) + " old · re-check for live" : "fresh from the shop page";
  return "Read " + clock(p.checkedAt) + " · " + how + " · " + seconds(p.elapsedMs);
}

function itemHtml(p, index) {
  const image = https(p.image)
    ? '<img alt="" loading="lazy" referrerpolicy="no-referrer" src="' + esc(p.image) + '">'
    : '<span class="ph" aria-hidden="true"></span>';
  const link = https(p.url);
  const title = (index + 1) + ". " + esc(p.name);
  return '<div class="item">' + image + "<div>" +
    (link ? '<a href="' + esc(link) + '" target="_blank" rel="noopener noreferrer">' + title + " ↗</a>" : "<strong>" + title + "</strong>") +
    "<small>" + esc(p.retailer) + " · " + cm(p.widthMm) + " × " + cm(p.depthMm) + " cm" + (p.round ? " (round)" : "") +
    " · " + esc(money(p.price, p.currency)) + " · " + esc(stockLabel(p.availability)) + "</small>" +
    (p.evidence ? "<small>Evidence: “" + esc(String(p.evidence).slice(0, 160)) + "”</small>" : "") +
    '<small class="live">' + esc(readLine(p)) + "</small>" +
    (p.lastChange ? '<small class="changed">Changed at ' + esc(clock(p.checkedAt)) + ": " + esc(p.lastChange) + "</small>" : "") +
    "</div></div>";
}

function render() {
  const banners = [];
  if (state.mock) banners.push('<div class="banner mock">MOCK DATA: invented values, nothing was read from a shop.</div>');
  if (!state.hasKey && !state.mock) banners.push('<div class="banner warn">No Context.dev key found. Add CONTEXT_DEV_API_KEY to .env and restart the server.</div>');
  if (state.error) banners.push('<div class="banner warn">' + esc(state.error) + "</div>");
  for (const warning of state.warnings) banners.push('<div class="banner warn">' + esc(warning) + "</div>");
  $("banners").innerHTML = banners.join("");
  $("find").disabled = state.busy;

  if (state.busy) {
    $("summary").textContent = "Searching shops and reading product pages live…";
    $("detail").textContent = "Usually 10 to 30 seconds: every page is read through Context.dev right now.";
    $("results").innerHTML = '<div class="empty">Reading shop pages…</div>';
    return;
  }
  if (!state.stats) {
    $("summary").textContent = "";
    $("detail").textContent = "";
    $("results").innerHTML = '<div class="empty">Choose what you need and select Find combinations.</div>';
    return;
  }

  const sp = space();
  const slots = (state.searchedSlots ?? state.slots).map((kind) => ({ kind }));
  const { combos, nearestOverMm, tooDeep, poolSizes } = findCombos(sp, slots, [...state.products.values()]);
  state.combos = new Map(combos.map((combo) => [combo.id, combo.items.map((item) => item.id)]));
  const s = state.stats;
  const retailers = new Set(combos.flatMap((combo) => combo.items.map((item) => item.retailer)));
  const crossShop = combos.filter((combo) => new Set(combo.items.map((item) => item.retailer)).size > 1).length;
  $("summary").textContent = combos.length + (combos.length === 1 ? " set fits" : " sets fit") + " · " + s.pagesRead +
    " shop pages read in " + seconds(s.elapsedMs) + " · " + retailers.size + (retailers.size === 1 ? " retailer" : " retailers") +
    (crossShop ? " · " + crossShop + " cross-shop" : "");
  $("detail").textContent = [
    s.usable + " products with verified dimensions",
    s.missingDimensions ? s.missingDimensions + " left out (no verifiable dimensions)" : "",
    s.notProductPages ? s.notProductPages + " pages were not product pages" : "",
    s.failed ? s.failed + " pages failed" : "",
    s.credits ? s.credits + " Context.dev credits used" : "",
    s.creditsRemaining != null ? s.creditsRemaining + " credits left" : "",
  ].filter(Boolean).join(" · ");

  if (!combos.length) {
    const missing = poolSizes.findIndex((size) => size === 0);
    const why = missing >= 0 ? "No usable product was read for item " + (missing + 1) + "."
      : nearestOverMm != null ? "The closest set needs " + cm(nearestOverMm) + " cm more along the wall."
      : tooDeep ? "Every set is deeper than " + cm(sp.depthCm * 10) + " cm." : "Nothing fits these measurements.";
    $("results").innerHTML = '<div class="empty"><strong>No set fits yet.</strong> ' + esc(why) + "</div>";
    return;
  }
  $("results").innerHTML = combos.slice(0, state.limit).map((combo) => {
    const priced = combo.items.every((item) => item.price != null) && new Set(combo.items.map((item) => item.currency || "EUR")).size === 1;
    const total = priced ? money(combo.items.reduce((sum, item) => sum + item.price, 0), combo.items[0].currency) + " for the set, shipping not included" : "";
    const busy = state.rechecking.has(combo.id);
    const watched = state.watching.has(combo.id);
    return '<article class="combo"><div class="combo-head"><h3>' + combo.items.map((item) => esc(item.name)).join(" + ") +
      '</h3><span class="spare">uses ' + cm(combo.usedMm) + " of " + cm(sp.widthCm * 10) + " cm · " + cm(combo.freeMm) + " cm spare</span></div>" +
      diagram(combo, sp) + combo.items.map(itemHtml).join("") +
      '<div class="combo-foot"><button type="button" class="quiet" data-recheck="' + esc(combo.id) + '"' + (busy ? " disabled" : "") + ">" +
      (busy ? "Re-reading " + combo.items.length + " pages live…" : "Re-check now") + "</button>" +
      '<button type="button" class="quiet" data-watch="' + esc(combo.id) + '">' + (watched ? "Stop watching" : "Watch this set") + "</button>" +
      (watched ? "<span>Watching: re-read every " + WATCH_MS / 1000 + " s</span>" : "") + (total ? "<span>" + esc(total) + "</span>" : "") +
      "</div></article>";
  }).join("") + (combos.length > state.limit ? '<button type="button" class="quiet" id="more">Show more sets</button>' : "");
}

function addLog(text, changed = false) {
  state.log.unshift({ at: new Date().toISOString(), text, changed });
  state.log = state.log.slice(0, 40);
  $("log").innerHTML = state.log.map((entry) =>
    "<li" + (entry.changed ? ' class="changed"' : "") + ">" + esc(clock(entry.at)) + " · " + esc(entry.text) + "</li>").join("");
}

function applyFresh(fresh) {
  const old = state.products.get(fresh.id);
  if (!old) return;
  if (!fresh.ok) {
    addLog(old.name + " · could not re-read (" + fresh.error + ") · keeping the read from " + clock(old.checkedAt));
    return;
  }
  const changes = [];
  if (fresh.price != null && fresh.price !== old.price) changes.push("price " + money(old.price, old.currency) + " → " + money(fresh.price, fresh.currency));
  if (fresh.availability && fresh.availability !== old.availability) changes.push("stock " + stockLabel(old.availability) + " → " + stockLabel(fresh.availability));
  const sized = fresh.widthMm && fresh.depthMm;
  if (sized && (fresh.widthMm !== old.widthMm || fresh.depthMm !== old.depthMm)) {
    changes.push("size " + (old.widthMm ? cm(old.widthMm) + " × " + cm(old.depthMm) : "unknown") + " → " + cm(fresh.widthMm) + " × " + cm(fresh.depthMm) + " cm");
  }
  const merged = { ...old, ...fresh };
  // A value the fresh read did not find keeps its last known value instead of being erased.
  for (const key of ["price", "currency", "availability", "heightMm", "evidence", "image", "sku", "colour", "material"]) {
    if (fresh[key] == null) merged[key] = old[key];
  }
  if (!sized) Object.assign(merged, { widthMm: old.widthMm, depthMm: old.depthMm, round: old.round });
  merged.lastChange = changes.length ? changes.join(" · ") : null;
  state.products.set(old.id, merged);
  addLog(merged.name + " · " + (changes.length ? changes.join(" · ") : "no change") + " · fresh read " + seconds(fresh.elapsedMs), changes.length > 0);
}

async function recheck(comboId, ids) {
  if (state.rechecking.has(comboId)) return;
  const items = ids.map((id) => state.products.get(id)).filter(Boolean);
  if (!items.length) return;
  state.rechecking.add(comboId);
  render();
  try {
    const res = await fetch("/api/recheck", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ items: items.map((item) => ({ url: item.url, kind: item.kind })) }),
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.message || data.error || "re-check failed");
    for (const fresh of data.products) applyFresh(fresh);
  } catch (error) {
    addLog("Re-check failed: " + error.message);
  } finally {
    state.rechecking.delete(comboId);
    render();
  }
}

function toggleWatch(comboId) {
  const current = state.watching.get(comboId);
  const names = (state.combos.get(comboId) ?? current?.ids ?? []).map((id) => state.products.get(id)?.name ?? id).join(" + ");
  if (current) {
    clearInterval(current.timer);
    state.watching.delete(comboId);
    addLog("Stopped watching " + names);
  } else {
    const ids = state.combos.get(comboId);
    if (!ids) return;
    const since = Date.now();
    const timer = setInterval(() => {
      if (Date.now() - since > WATCH_MAX_MS) {
        clearInterval(timer);
        state.watching.delete(comboId);
        addLog("Stopped watching after 30 min");
        render();
        return;
      }
      void recheck(comboId, ids);
    }, WATCH_MS);
    state.watching.set(comboId, { timer, ids, since });
    addLog("Watching " + names + ": re-read every " + WATCH_MS / 1000 + " s");
    void recheck(comboId, ids);
  }
  render();
}

async function search() {
  const run = ++state.run;
  for (const { timer } of state.watching.values()) clearInterval(timer);
  state.watching.clear();
  state.busy = true;
  state.error = "";
  state.warnings = [];
  state.limit = 8;
  render();
  try {
    const res = await fetch("/api/search", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ kinds: state.slots }),
    });
    const data = await res.json();
    if (run !== state.run) return; // a newer search owns the screen
    if (!res.ok) {
      state.error = data.message || data.error || "Search failed";
      state.stats = null;
      return;
    }
    state.products = new Map(data.products.map((p) => [p.id, p]));
    state.stats = data.stats;
    state.warnings = data.warnings || [];
    state.mock = Boolean(data.mock);
    state.searchedSlots = [...state.slots];
  } catch {
    if (run === state.run) state.error = "Could not reach the local server.";
  } finally {
    if (run === state.run) {
      state.busy = false;
      render();
    }
  }
}

$("form").addEventListener("submit", (event) => {
  event.preventDefault();
  void search();
});
$("form").addEventListener("input", (event) => {
  if (["width", "depth", "gap"].includes(event.target.id)) render(); // instant recalculation, no new web calls
});
$("slots").addEventListener("change", (event) => {
  const index = event.target.dataset.slot;
  if (index !== undefined) state.slots[Number(index)] = event.target.value;
});
$("slots").addEventListener("click", (event) => {
  if (event.target.id !== "remove") return;
  state.slots.pop();
  renderSlots();
});
$("add").addEventListener("click", () => {
  if (state.slots.length >= 3) return;
  state.slots.push("table");
  renderSlots();
});
$("results").addEventListener("click", (event) => {
  const target = event.target.closest("button");
  if (!target) return;
  if (target.id === "more") {
    state.limit += 8;
    render();
  } else if (target.dataset.recheck) {
    const ids = state.combos.get(target.dataset.recheck);
    if (ids) void recheck(target.dataset.recheck, ids);
  } else if (target.dataset.watch) {
    toggleWatch(target.dataset.watch);
  }
});

renderSlots();
render();
fetch("/api/health").then((res) => res.json()).then((health) => {
  state.kinds = health.kinds || state.kinds;
  state.hasKey = Boolean(health.hasKey);
  state.mock = Boolean(health.mock);
  renderSlots();
  render();
}).catch(() => {});
