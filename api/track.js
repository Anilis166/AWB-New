// /api/track.js — Vercel Serverless Function
// CORS proxy + HMAC signer untuk Biteship & Binderbyte API
// Dipanggil sebagai: /api/track?awb=004612348765&courier=sicepat&provider=biteship

import { createHmac } from "node:crypto";

const BITESHIP_BASE = "https://api.biteship.com";
const BITESHIP_SECRET = process.env.BITESHIP_SECRET;
const BINDERBYTE_KEY = process.env.BINDERBYTE_KEY;

// ── Upstash Redis rate limiting ─────────────────────────
const UPSTASH_URL = process.env.UPSTASH_REDIS_REST_URL;
const UPSTASH_TOKEN = process.env.UPSTASH_REDIS_REST_TOKEN;
const RATE_LIMIT_MAX = 300;  // max requests per window (dinaikkan dari 60 → 300 untuk support 32 workers)
const RATE_LIMIT_WINDOW = 60; // seconds

async function redisExec(command) {
  if (!UPSTASH_URL || !UPSTASH_TOKEN) {
    throw new Error("Upstash rate limiting is not configured");
  }
  const resp = await fetch(UPSTASH_URL, {
    method: "POST",
    headers: {
      "Authorization": `Bearer ${UPSTASH_TOKEN}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(command),
    signal: AbortSignal.timeout(3000),
  });
  if (!resp.ok) throw new Error(`Upstash HTTP ${resp.status}`);
  const data = await resp.json();
  if (data.error) throw new Error("Upstash command failed");
  return data.result;
}

async function checkRateLimit(ip) {
  const key = `rate:${ip}`;
  const count = await redisExec(["INCR", key]);
  if (count === 1) await redisExec(["EXPIRE", key, RATE_LIMIT_WINDOW]);
  if (!Number.isFinite(count)) throw new Error("Upstash returned an invalid rate-limit count");
  return count <= RATE_LIMIT_MAX;
}

// ── CORS headers ──────────────────────────────────────────
function corsHeaders() {
  return {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
    "Access-Control-Max-Age": "86400",
  };
}

// ── HMAC-SHA256 signature untuk Biteship ──────────────────
// Pakai node:crypto createHmac (lebih reliable dari Web Crypto di Vercel)
function generateBiteshipSignature(method, path) {
  if (!BITESHIP_SECRET) throw new Error("Biteship tracking is not configured");
  const timestamp = Math.floor(Date.now() / 1000).toString();
  const message = `${timestamp}|${method}|${path}`;
  const signature = createHmac("sha256", BITESHIP_SECRET)
    .update(message)
    .digest("hex");
  return { signature, timestamp };
}

// ── Rotating mobile UA ────────────────────────────────────
const ANDROID_VERSIONS = ["14", "13", "12", "11", "10"];
const CHROME_MAJORS = ["126", "125", "124", "123", "122", "121"];
const DEVICES = [
  "Pixel 8", "Pixel 7", "SM-G998B", "SM-G996B",
  "Xiaomi 14", "Xiaomi 13", "Redmi Note 12",
  "ONEPLUS A6013", "M2007J3SG",
];

function buildMobileUa() {
  const android = ANDROID_VERSIONS[Math.floor(Math.random() * ANDROID_VERSIONS.length)];
  const chrome = CHROME_MAJORS[Math.floor(Math.random() * CHROME_MAJORS.length)];
  const device = DEVICES[Math.floor(Math.random() * DEVICES.length)];
  return `Mozilla/5.0 (Linux; Android ${android}; ${device}) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${chrome}.0.0.0 Mobile Safari/537.36`;
}

// ── Biteship tracking ─────────────────────────────────────
async function trackBiteship(awb, courier) {
  const path = `/v1/public/trackings/${encodeURIComponent(awb)}/couriers/${encodeURIComponent(courier)}`;
  const url = BITESHIP_BASE + path;
  const { signature, timestamp } = generateBiteshipSignature("GET", path);

  const headers = {
    "Accept": "application/json",
    "Content-Type": "application/json",
    "Authorization": "Public",
    "Origin": "https://biteship.com",
    "Referer": "https://biteship.com/id/cek-resi",
    "x-biteship-public-request-signature": signature,
    "x-biteship-public-request-timestamp": timestamp,
    "User-Agent": buildMobileUa(),
  };

  const maxRetries = 3;
  for (let attempt = 0; attempt < maxRetries; attempt++) {
    try {
      const resp = await fetch(url, { headers, signal: AbortSignal.timeout(30000) });

      // 404 = AWB tidak ada
      if (resp.status === 404) {
        return { status: 404, body: null };
      }

      // 429 = rate limited (langsung return 429, tidak usah pause backend 10 detik yg bikin worker hang)
      if (resp.status === 429) {
        return { status: 429, body: null };
      }

      // 5xx = retry
      if (resp.status >= 500 && attempt < maxRetries - 1) {
        await new Promise((r) => setTimeout(r, 1500 * Math.pow(2, attempt)));
        continue;
      }

      const json = await resp.json();
      return { status: resp.status, body: json };
    } catch (err) {
      if (attempt < maxRetries - 1) {
        await new Promise((r) => setTimeout(r, 1500 * Math.pow(2, attempt)));
        continue;
      }
      throw err;
    }
  }
  return { status: 0, body: null };
}

// ── Binderbyte tracking ───────────────────────────────────
async function trackBinderbyte(awb, courier) {
  const url = `https://api.binderbyte.com/v1/track?api_key=${encodeURIComponent(BINDERBYTE_KEY)}&courier=${encodeURIComponent(courier)}&awb=${encodeURIComponent(awb)}`;
  const resp = await fetch(url, { signal: AbortSignal.timeout(30000) });
  const json = await resp.json();
  return { status: resp.status, body: json };
}

// ── Main handler ──────────────────────────────────────────
export default async function handler(req, res) {
  // Handle CORS preflight
  if (req.method === "OPTIONS") {
    Object.entries(corsHeaders()).forEach(([k, v]) => res.setHeader(k, v));
    return res.status(204).end();
  }

  // Handle keep-alive HEAD requests (warm up function, skip rate limit)
  if (req.method === "HEAD") {
    Object.entries(corsHeaders()).forEach(([k, v]) => res.setHeader(k, v));
    return res.status(200).end();
  }

  Object.entries(corsHeaders()).forEach(([k, v]) => res.setHeader(k, v));

  const { awb, courier = "sicepat", provider = "biteship" } = req.query;

  if (!awb) {
    return res.status(400).json({ error: "Missing 'awb' parameter" });
  }
  if (!["biteship", "binderbyte"].includes(provider)) {
    return res.status(400).json({ error: "Unsupported tracking provider" });
  }
  if (provider === "binderbyte" && !BINDERBYTE_KEY) {
    return res.status(503).json({ error: "Binderbyte tracking is not configured", success: false });
  }
  if (provider === "biteship" && !BITESHIP_SECRET) {
    return res.status(503).json({ error: "Biteship tracking is not configured", success: false });
  }

  // Skip rate limit for keep-alive pings
  const forwardedFor = req.headers["x-forwarded-for"];
  const ip = (Array.isArray(forwardedFor) ? forwardedFor[0] : forwardedFor)?.split(",")[0].trim()
    || req.socket.remoteAddress
    || "unknown";
  if (awb !== "keepalive") {
    let allowed;
    try {
      allowed = await checkRateLimit(ip);
    } catch {
      return res.status(503).json({
        error: "Tracking rate limiter is unavailable",
        success: false,
      });
    }
    if (!allowed) {
      return res.status(429).json({
        error: "Rate limit exceeded. Max 300 requests per minute.",
        success: false,
      });
    }
  }

  try {
    let result;
    if (provider === "binderbyte") {
      result = await trackBinderbyte(awb, courier);
    } else {
      result = await trackBiteship(awb, courier);
    }

    return res.status(result.status || 200).json(result.body);
  } catch (err) {
    return res.status(500).json({
      error: err.message || "Tracking failed",
      success: false,
    });
  }
}
