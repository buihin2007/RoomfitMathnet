import { api } from "../lib/core.js";

export function route(name) {
  return async function handler(req, res) {
    if (req.method !== "POST") return res.status(405).json({ error: "method_not_allowed" });
    let body = req.body;
    if (typeof body === "string") {
      try { body = JSON.parse(body); } catch { return res.status(400).json({ error: "bad_request" }); }
    }
    const [status, payload] = await api(name, body);
    res.setHeader("Cache-Control", "no-store");
    return res.status(status).json(payload);
  };
}
