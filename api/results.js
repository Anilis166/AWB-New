// /api/results.js — Vercel Serverless Function
// Baca data VPS scanner dari Upstash Redis
// GET type=awbs → daftar AWB dari VPS
// POST → kirim command ke scanner
const UPSTASH_URL = process.env.UPSTASH_REDIS_REST_URL;
const UPSTASH_TOKEN = process.env.UPSTASH_REDIS_REST_TOKEN;

function corsHeaders(res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  res.setHeader("Access-Control-Max-Age", "86400");
}

async function redis(...args) {
  const resp = await fetch(UPSTASH_URL, {
    method: "POST",
    headers: {
      "Authorization": `Bearer ${UPSTASH_TOKEN}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(args),
    signal: AbortSignal.timeout(10000),
  });
  if (!resp.ok) throw new Error(`Upstash HTTP ${resp.status}`);
  const data = await resp.json();
  return data.result;
}

export default async function handler(req, res) {
  corsHeaders(res);

  if (req.method === "OPTIONS") return res.status(204).end();

  try {
    if (req.method === "GET") {
      const { type = "awbs" } = req.query;

      if (type === "awbs") {
        // Return list of AWB numbers from VPS cache
        try {
          const awbs = await redis("SMEMBERS", "awb:vps:awbs");
          return res.status(200).json({ awbs: awbs || [] });
        } catch {
          return res.status(200).json({ awbs: [] });
        }
      }

      if (type === "status") {
        try {
          const raw = await redis("GET", "awb:scanner:status");
          return res.status(200).json({ status: raw ? JSON.parse(raw) : { running: false, phase: "idle" } });
        } catch {
          return res.status(200).json({ status: { running: false, phase: "idle" } });
        }
      }

      if (type === "count") {
        try {
          const count = await redis("SCARD", "awb:vps:awbs");
          return res.status(200).json({ count: count || 0 });
        } catch {
          return res.status(200).json({ count: 0 });
        }
      }

      return res.status(400).json({ error: "Unknown type. Use: awbs, status, count" });
    }

    if (req.method === "POST") {
      const { action, params } = req.body;

      if (!action) {
        return res.status(400).json({ error: "action required" });
      }

      const cmd = { action };
      if (params) cmd.params = params;

      await redis("SET", "awb:scanner:command", JSON.stringify(cmd));
      return res.status(200).json({ ok: true, command: cmd });
    }

    return res.status(405).json({ error: "Method not allowed" });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
}
