import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";

const port = Number(process.env.PORT || 8001);
const publicDir = path.resolve("public");
const spxSalt = "MGViZmZmZTYzZDJhNDgxY2Y1N2ZlN2Q1ZWJkYzlmZDY=";

function send(res, status, body, contentType = "application/json") {
  res.writeHead(status, {
    "Content-Type": contentType,
    "Cache-Control": "no-cache, no-store, must-revalidate",
  });
  res.end(body);
}

async function trackSpx(res, awb) {
  if (!awb) return send(res, 400, JSON.stringify({ ok: false, error: "Missing AWB" }));

  const timestamp = Math.floor(Date.now() / 1000);
  const signature = crypto.createHash("sha256").update(`${awb}${timestamp}${spxSalt}`).digest("hex");
  const trackingNumber = `${awb}|${timestamp}${signature}`;
  const url = `https://spx.co.id/api/v2/fleet_order/tracking/search?sls_tracking_number=${encodeURIComponent(trackingNumber)}`;

  try {
    const response = await fetch(url, {
      headers: {
        accept: "application/json, text/plain, */*",
        "accept-language": "id-ID,id;q=0.9",
        referer: `https://spx.co.id/m/tracking-detail/${encodeURIComponent(awb)}`,
        source: "mobile",
        "user-agent": "Mozilla/5.0 (Linux; Android 10; K) AppleWebKit/537.36",
        "x-language": "id",
      },
      signal: AbortSignal.timeout(15000),
    });
    const payload = await response.json();
    const data = payload?.data;
    const records = Array.isArray(data?.tracking_list)
      ? data.tracking_list
      : Array.isArray(data?.sls_tracking_info?.records)
        ? data.sls_tracking_info.records
        : Array.isArray(data?.records)
          ? data.records
          : [];
    if (!response.ok || payload?.retcode !== 0 || records.length === 0) {
      return send(res, response.ok ? 404 : response.status, JSON.stringify({
        ok: false,
        error: "SPX tracking number not found",
      }));
    }

    const location = (value) => typeof value === "string"
      ? value
      : value?.location_name || value?.full_address || "";
    const last = records[0] || {};
    const result = {
      resi: awb,
      waybill_id: awb,
      latest_status: last.status || last.tracking_name || last.description || data?.current_status || "Dalam proses",
      latest_checkpoint_date: last.timestamp
        ? new Date(Number(last.timestamp) * 1000).toISOString()
        : last.actual_time
        ? new Date(Number(last.actual_time) * 1000).toISOString()
        : data?.latest_checkpoint_date || "",
      latest_note: last.message || last.description || last.buyer_description || "",
      location: location(last.current_location) || location(last.next_location),
      records: records.map((record) => ({
        ...record,
        actual_time: record.timestamp
          ? new Date(Number(record.timestamp) * 1000).toISOString()
          : typeof record.actual_time === "number"
            ? new Date(record.actual_time * 1000).toISOString()
            : String(record.actual_time || ""),
      })),
    };
    send(res, 200, JSON.stringify({ ok: true, result }));
  } catch (error) {
    send(res, 502, JSON.stringify({ ok: false, error: "SPX API unavailable" }));
  }
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  if (req.method === "OPTIONS") {
    res.writeHead(204);
    return res.end();
  }
  if (url.pathname === "/api/spx-track") {
    return trackSpx(res, url.searchParams.get("awb"));
  }

  const requested = url.pathname === "/" ? "/index.html" : url.pathname;
  const filePath = path.resolve(publicDir, `.${requested}`);
  if (!filePath.startsWith(publicDir)) return send(res, 403, "Forbidden", "text/plain");
  try {
    const body = await fs.promises.readFile(filePath);
    const ext = path.extname(filePath);
    const types = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css", ".json": "application/json", ".png": "image/png" };
    send(res, 200, body, types[ext] || "application/octet-stream");
  } catch {
    send(res, 404, "Not found", "text/plain");
  }
});

server.listen(port, "0.0.0.0", () => {
  console.log(`AWB preview listening on http://0.0.0.0:${port}`);
});
