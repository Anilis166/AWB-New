// /api/model — Auto-sync ML model
// POST: simpan model (dari builder)
// GET: load model (untuk buyer)
// Storage: in-memory (resets on cold start, fallback ke seed file)

import { readFileSync } from "fs";
import { join } from "path";

let cachedModel = null;
let lastUpdate = null;

export default function handler(req, res) {
  // CORS headers
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");

  if (req.method === "OPTIONS") {
    return res.status(200).end();
  }

  if (req.method === "POST") {
    try {
      const body = req.body;
      if (!body || !body.midModel) {
        return res.status(400).json({ error: "Invalid model data" });
      }
      cachedModel = body;
      lastUpdate = new Date().toISOString();
      return res.status(200).json({ ok: true, lastUpdate });
    } catch (e) {
      return res.status(500).json({ error: e.message });
    }
  }

  if (req.method === "GET") {
    // 1. Coba dari memory (kalau belum cold start)
    if (cachedModel) {
      return res.status(200).json(cachedModel);
    }
    // 2. Fallback: baca seed file
    try {
      const seedPath = join(process.cwd(), "public", "awb_model_seed.json");
      const data = JSON.parse(readFileSync(seedPath, "utf-8"));
      cachedModel = data;
      return res.status(200).json(data);
    } catch (e) {
      return res.status(404).json({ error: "No model available" });
    }
  }

  return res.status(405).json({ error: "Method not allowed" });
}
