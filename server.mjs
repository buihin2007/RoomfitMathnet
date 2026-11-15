// Roomfit local server. Zero dependencies, Node 18+.
// Reads live shop pages through Context.dev: Search finds product pages,
// Scrape (JSON + Product formats) reads dimensions, price and stock.
import http from "node:http";
import { readFile } from "node:fs/promises";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC = path.join(ROOT, "public");

function loadEnv(file) {
  if (!existsSync(file)) return;
  for (const line of readFileSync(file, "utf8").split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Za-z0-9_]+)\s*=\s*(.*?)\s*$/);
    if (m && !(m[1] in process.env)) process.env[m[1]] = m[2].replace(/^["']|["']$/g, "");
  }
}
loadEnv(path.join(ROOT, ".env"));

const KEY = process.env.CONTEXT_DEV_API_KEY || "";
const MOCK = process.env.MOCK === "1";
const PORT = Number(process.env.PORT || 3000);
const HOST = process.env.HOST || "127.0.0.1";
const API = (process.env.CONTEXT_API_BASE || "https://api.context.dev/v1").replace(/\/$/, "");
// First search may reuse a copy up to this old. Re-check always uses 0 (fresh).
const SEARCH_MAX_AGE_MS = Number(process.env.SEARCH_MAX_AGE_MS ?? 15 * 60 * 1000);
const MAX_URLS_PER_KIND = Number(process.env.MAX_URLS_PER_KIND ?? 8);

// Finnish market. Search is limited to these shops, re-check only accepts them.
const SHOPS = ["ikea.com", "jysk.fi", "vidaxl.fi", "veke.fi", "beliani.fi", "masku.com", "sotka.fi"];

// "curated" URLs are a safety net so a search always has pages to read.
// They are still read live through Context.dev on every search.
const KINDS = {
  cabinet: {
    label: "Low cabinet / TV bench",
    queries: ["matala tv-taso", "tv bench low cabinet"],
    curated: ["https://www.ikea.com/fi/en/p/besta-tv-bench-black-brown-90294512/"],
  },
  table: {
    label: "Side table",
    queries: ["sivupöytä", "apupöytä side table"],
    curated: [
      "https://www.ikea.com/fi/en/p/gladom-tray-table-black-50411990/",
      "https://jysk.fi/olohuone/sohvapoydat-ja-sivupoydat/sivupoyta-nybo-o55-lamp-tammenvarinen-musta",
      "https://jysk.fi/olohuone/sohvapoydat-ja-sivupoydat/sivupoyta-randerup-o47-musta",
    ],
  },
  desk: { label: "Desk", queries: ["työpöytä"], curated: [] },
  shelf: { label: "Shelving unit", queries: ["kirjahylly"], curated: [] },
};

const SCHEMA = {
  type: "object",
  properties: {
    width: { type: ["number", "null"], description: "Assembled width (Leveys), number exactly as written on the page" },
    depth: { type: ["number", "null"], description: "Assembled depth (Syvyys), number exactly as written on the page" },
    height: { type: ["number", "null"], description: "Assembled height (Korkeus), number exactly as written on the page" },
    diameter: { type: ["number", "null"], description: "Diameter (Halkaisija, Ø) of a round product, number exactly as written" },
    unit: { type: ["string", "null"], description: "Unit of the numbers above. One of: mm, cm, m, in" },
    dimension_evidence: { type: ["string", "null"], description: "Short verbatim quote from the page containing these dimensions" },
    colour: { type: ["string", "null"] },
    material: { type: ["string", "null"] },
  },
  required: ["width", "depth", "height", "diameter", "unit", "dimension_evidence", "colour", "material"],
};

const INSTRUCTIONS =
  "Use only facts explicitly stated on this page for the selected product variant. " +
  "Extract the ASSEMBLED product dimensions, with numbers exactly as written and their unit. " +
  "Finnish labels: Leveys = width, Syvyys = depth, Korkeus = height, Halkaisija or Ø = diameter, 'Koko kasattuna' = assembled size. " +
  "Ignore package dimensions (Pakkauskoko, package, packaging), other variants and related products. " +
  "For a round product give diameter and leave width and depth null. " +
  "dimension_evidence is a short verbatim quote (max 140 characters) that contains the dimensions. " +
  "Keep the page's own material wording and never infer solid wood from a finish. Use null for anything not stated.";

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const hostOf = (u) => new URL(u).hostname.replace(/^www\./, "");
const idOf = (u) => hostOf(u) + new URL(u).pathname.replace(/\/$/, "");
const cleanUrl = (u) => {
  const x = new URL(u);
  x.hash = "";
  for (const key of [...x.searchParams.keys()]) if (/^(utm_|gclid|fbclid|msclkid)/i.test(key)) x.searchParams.delete(key);
  return x.toString();
};
const allowedHost = (u) => {
  try {
    const x = new URL(u);
    const host = hostOf(u);
    return x.protocol === "https:" && SHOPS.some((shop) => host === shop || host.endsWith("." + shop));
  } catch {
    return false;
  }
};

function looksLikeProduct(u) {
  const { pathname } = new URL(u);
  const host = hostOf(u);
  const segments = pathname.split("/").filter(Boolean);
  if (host === "ikea.com") return /^\/fi\/(fi|en)\/p\//.test(pathname);
  if (host === "jysk.fi") return segments.length >= 3;
  if (!segments.length) return false;
  return !/\/(blog|inspiraatio|artikkelit|kategoria|category|search|haku|asiakaspalvelu)(\/|$)/i.test(pathname);
}

// One POST to Context.dev with a deadline and a single retry on 429 / 5xx.
async function ctx(pathname, body, timeoutMs) {
  for (let attempt = 0; ; attempt++) {
    const started = Date.now();
    let res;
    let data = null;
    try {
      res = await fetch(API + pathname, {
        method: "POST",
        headers: { Authorization: "Bearer " + KEY, "Content-Type": "application/json" },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(timeoutMs),
      });
      data = await res.json().catch(() => null);
    } catch (error) {
      return { ok: false, status: 0, error: error?.name === "TimeoutError" ? "timeout" : "network", elapsedMs: Date.now() - started };
    }
    if (res.ok) return { ok: true, status: res.status, data, elapsedMs: Date.now() - started };
    if ((res.status === 429 || res.status >= 500) && attempt === 0) {
      await sleep(Math.min(5000, (Number(res.headers.get("retry-after")) || 1) * 1000));
      continue;
    }
    return { ok: false, status: res.status, error: data?.error_code || "http_" + res.status, elapsedMs: Date.now() - started };
  }
}

const UNIT_TO_MM = { mm: 1, cm: 10, m: 1000, in: 25.4, inch: 25.4, inches: 25.4 };

function normalize(url, kind, data, meta) {
  const j = data?.json?.success ? data.json.data ?? {} : {};
  const productData = data?.product?.success ? data.product.data : null;
  const p = productData?.product ?? null;
  const factor = UNIT_TO_MM[String(j.unit ?? "cm").trim().toLowerCase()] ?? 10;
  const toMm = (value) => (typeof value === "number" && Number.isFinite(value) && value > 0 ? Math.round(value * factor) : null);
  let widthMm = toMm(j.width);
  let depthMm = toMm(j.depth);
  const heightMm = toMm(j.height);
  const diameterMm = toMm(j.diameter);
  let round = false;
  if (diameterMm && (!widthMm || !depthMm)) {
    widthMm = depthMm = diameterMm;
    round = true;
  }
  // Reject implausible footprints instead of guessing.
  const plausible = widthMm >= 100 && widthMm <= 4000 && depthMm >= 100 && depthMm <= 2000;
  const image = p?.imageUrl || p?.images?.[0] || data?.metadata?.image || null;
  return {
    id: idOf(url),
    url,
    finalUrl: data?.url || url,
    kind,
    ok: true,
    isProductPage: productData ? productData.isProductPage : null,
    name: p?.name || data?.metadata?.title || idOf(url),
    retailer: hostOf(url),
    sku: p?.sku ?? null,
    image: typeof image === "string" ? image : null,
    price: typeof p?.price === "number" ? p.price : null,
    currency: p?.currency ?? null,
    availability: p?.availability ?? null,
    widthMm: plausible ? widthMm : null,
    depthMm: plausible ? depthMm : null,
    heightMm,
    round: plausible && round,
    colour: j.colour ?? null,
    material: j.material ?? null,
    evidence: j.dimension_evidence || (Array.isArray(p?.dimensions) && p.dimensions.length ? p.dimensions.join(" · ") : null),
    cache: { status: data?.cache_metadata?.status ?? null, ageMs: data?.cache_metadata?.age_ms ?? null },
    credits: data?.key_metadata?.credits_consumed ?? null,
    creditsRemaining: data?.key_metadata?.credits_remaining ?? null,
    ...meta,
  };
}

async function scrapeProduct(url, kind, maxAgeMs, source) {
  const r = await ctx(
    "/web/scrape",
    {
      url,
      formats: { json: true, product: true },
      jsonParams: { schema: SCHEMA, instructions: INSTRUCTIONS },
      maxAgeMs,
      timeoutOpts: { milliseconds: 25000, behavior: "return-partial" },
    },
    28000,
  );
  const checkedAt = new Date().toISOString();
  if (!r.ok) return { id: idOf(url), url, kind, ok: false, error: r.error, checkedAt, elapsedMs: r.elapsedMs, source };
  return normalize(url, kind, r.data, { checkedAt, elapsedMs: r.elapsedMs, source });
}

// ---- mock mode (MOCK=1): invented values, only for testing the UI offline ----
const MOCK_ROWS = [
  ["cabinet", "BESTÅ TV bench (mock)", KINDS.cabinet.curated[0], 1200, 400, false, 55],
  ["table", "GLADOM tray table (mock)", KINDS.table.curated[0], 450, 450, true, 19.99],
  ["table", "NYBO side table (mock)", KINDS.table.curated[1], 550, 550, true, 39.99],
  ["table", "RANDERUP side table (mock)", KINDS.table.curated[2], 470, 470, true, 12.95],
];
let mockTick = 0;
function mockProduct([kind, name, url, widthMm, depthMm, round, price]) {
  const flip = mockTick % 2 === 1 && name.startsWith("RANDERUP");
  return {
    id: idOf(url), url, finalUrl: url, kind, ok: true, isProductPage: true, name, retailer: hostOf(url), sku: null, image: null,
    price: flip ? price - 1 : price, currency: "EUR", availability: "in_stock", widthMm, depthMm, heightMm: null, round,
    colour: null, material: null, evidence: "mock data, not read from the shop", cache: { status: "miss", ageMs: 0 },
    credits: 0, creditsRemaining: null, checkedAt: new Date().toISOString(), elapsedMs: 5, source: "mock",
  };
}

async function handleSearch(body) {
  const started = Date.now();
  const kinds = [...new Set((Array.isArray(body.kinds) ? body.kinds : []).filter((k) => KINDS[k]))].slice(0, 3);
  if (!kinds.length) return [400, { error: "no_kinds" }];
  if (MOCK) {
    const products = MOCK_ROWS.filter((row) => kinds.includes(row[0])).map(mockProduct);
    return [200, { mock: true, products, warnings: [], stats: { searchCalls: 0, urlsFound: 0, pagesRead: products.length, usable: products.length, missingDimensions: 0, notProductPages: 0, failed: 0, credits: 0, creditsRemaining: null, elapsedMs: Date.now() - started } }];
  }
  const warnings = [];
  let searchCalls = 0;
  let urlsFound = 0;
  const perKind = await Promise.all(kinds.map(async (kind) => {
    const responses = await Promise.all(KINDS[kind].queries.map((query) => ctx(
      "/web/search",
      { query, numResults: 10, includeDomains: SHOPS, country: "fi", timeoutOpts: { milliseconds: 10000, behavior: "return-partial" } },
      12000,
    )));
    const urls = new Map();
    for (const u of KINDS[kind].curated) urls.set(idOf(u), { url: u, source: "curated" });
    const cap = KINDS[kind].curated.length + MAX_URLS_PER_KIND;
    for (const r of responses) {
      searchCalls++;
      if (!r.ok) {
        warnings.push("Search for " + KINDS[kind].label + " failed (" + r.error + ")");
        continue;
      }
      for (const item of r.data?.results ?? []) {
        urlsFound++;
        try {
          if (urls.size < cap && allowedHost(item.url) && looksLikeProduct(item.url) && !urls.has(idOf(item.url))) {
            urls.set(idOf(item.url), { url: cleanUrl(item.url), source: "search" });
          }
        } catch { /* skip malformed URL */ }
      }
    }
    return [...urls.values()].map((entry) => ({ ...entry, kind }));
  }));
  const jobs = perKind.flat();
  const read = await Promise.all(jobs.map((job) => scrapeProduct(job.url, job.kind, SEARCH_MAX_AGE_MS, job.source)));
  const failed = read.filter((p) => !p.ok);
  const notProduct = read.filter((p) => p.ok && p.isProductPage === false);
  const products = read.filter((p) => p.ok && p.isProductPage !== false);
  const missingDimensions = products.filter((p) => !p.widthMm || !p.depthMm).length;
  if (failed.length) warnings.push(failed.length + " shop page(s) could not be read (" + [...new Set(failed.map((p) => p.error))].join(", ") + ")");
  const credits = read.reduce((sum, p) => sum + (p.credits ?? 0), 0);
  const remaining = read.map((p) => p.creditsRemaining).filter((v) => typeof v === "number");
  const stats = {
    searchCalls, urlsFound, pagesRead: read.length, usable: products.length - missingDimensions, missingDimensions,
    notProductPages: notProduct.length, failed: failed.length, credits,
    creditsRemaining: remaining.length ? Math.min(...remaining) : null, elapsedMs: Date.now() - started,
  };
  console.log("[search]", kinds.join(","), JSON.stringify(stats));
  return [200, { mock: false, products, warnings, stats }];
}

async function handleRecheck(body) {
  const started = Date.now();
  const items = (Array.isArray(body.items) ? body.items : [])
    .filter((item) => item && KINDS[item.kind] && typeof item.url === "string" && allowedHost(item.url))
    .slice(0, 6);
  if (!items.length) return [400, { error: "no_valid_urls" }];
  let products;
  if (MOCK) {
    mockTick++;
    products = items.map((item) => {
      const row = MOCK_ROWS.find((r) => idOf(r[2]) === idOf(item.url));
      return row ? mockProduct(row) : { id: idOf(item.url), url: item.url, kind: item.kind, ok: false, error: "not_in_mock", checkedAt: new Date().toISOString(), elapsedMs: 1 };
    });
  } else {
    products = await Promise.all(items.map((item) => scrapeProduct(item.url, item.kind, 0, "recheck")));
  }
  const elapsedMs = Date.now() - started;
  console.log("[recheck]", items.length, "page(s)", elapsedMs + " ms", products.filter((p) => !p.ok).length + " failed");
  return [200, { mock: MOCK, products, elapsedMs }];
}

const TYPES = {
  ".html": "text/html; charset=utf-8", ".mjs": "text/javascript; charset=utf-8", ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8", ".svg": "image/svg+xml", ".ico": "image/x-icon",
};

async function readJson(req) {
  let raw = "";
  for await (const chunk of req) {
    raw += chunk;
    if (raw.length > 20000) throw new SyntaxError("too large");
  }
  return raw ? JSON.parse(raw) : {};
}

function send(res, status, body) {
  res.writeHead(status, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" });
  res.end(JSON.stringify(body));
}

const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, "http://localhost");
    if (req.method === "GET" && url.pathname === "/api/health") {
      return send(res, 200, {
        ok: true, hasKey: Boolean(KEY), mock: MOCK, shops: SHOPS, searchMaxAgeMs: SEARCH_MAX_AGE_MS,
        kinds: Object.fromEntries(Object.entries(KINDS).map(([id, kind]) => [id, kind.label])),
      });
    }
    if (req.method === "POST" && (url.pathname === "/api/search" || url.pathname === "/api/recheck")) {
      if (!KEY && !MOCK) return send(res, 503, { error: "missing_key", message: "Set CONTEXT_DEV_API_KEY in .env and restart the server." });
      const body = await readJson(req);
      const [status, payload] = url.pathname === "/api/search" ? await handleSearch(body) : await handleRecheck(body);
      return send(res, status, payload);
    }
    if (req.method !== "GET") return send(res, 405, { error: "method_not_allowed" });
    const relative = url.pathname === "/" ? "index.html" : decodeURIComponent(url.pathname).replace(/^\/+/, "");
    const file = path.join(PUBLIC, relative);
    if (!file.startsWith(PUBLIC + path.sep)) return send(res, 403, { error: "forbidden" });
    const data = await readFile(file).catch(() => null);
    if (!data) return send(res, 404, { error: "not_found" });
    res.writeHead(200, { "Content-Type": TYPES[path.extname(file)] || "application/octet-stream", "Cache-Control": "no-store" });
    res.end(data);
  } catch (error) {
    const bad = error instanceof SyntaxError;
    if (!bad) console.error("[error]", error?.message);
    send(res, bad ? 400 : 500, { error: bad ? "bad_request" : "server_error" });
  }
});

server.listen(PORT, HOST, () => {
  console.log("Roomfit running at http://" + (HOST === "0.0.0.0" ? "localhost" : HOST) + ":" + PORT);
  console.log(MOCK ? "MOCK=1: using invented data, no Context.dev calls." : KEY ? "Context.dev key loaded." : "No CONTEXT_DEV_API_KEY found. Add it to .env and restart.");
});
