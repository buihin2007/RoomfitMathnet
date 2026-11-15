// Roomfit local server. Zero dependencies, Node 18+.
// Reads live shop pages through Context.dev: Search finds product pages,
// Scrape (JSON + Product formats) reads dimensions, price and stock.
import http from "node:http";
import { readFile } from "node:fs/promises";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { api, health, KEY, MOCK } from "./lib/core.js";

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

const PORT = Number(process.env.PORT || 3000);
const HOST = process.env.HOST || "127.0.0.1";

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
      return send(res, 200, health());
    }
    if (req.method === "POST" && (url.pathname === "/api/search" || url.pathname === "/api/recheck")) {
      const body = await readJson(req);
      const [status, payload] = await api(url.pathname === "/api/search" ? "search" : "recheck", body);
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
  console.log(MOCK() ? "MOCK=1: using invented data, no Context.dev calls." : KEY() ? "Context.dev key loaded." : "No CONTEXT_DEV_API_KEY found. Add it to .env and restart.");
});
