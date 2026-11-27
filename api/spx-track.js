import { createHash } from "node:crypto";

const SPX_BASE = "https://spx.co.id";
const SPX_SALT = "MGViZmZmZTYzZDJhNDgxY2Y1N2ZlN2Q1ZWJkYzlmZDY=";

function corsHeaders() {
  return {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "GET, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
  };
}

function locationName(location) {
  if (!location) return "";
  if (typeof location === "string") return location;
  return location.location_name || location.name || "";
}

function checkpointTime(record) {
  if (record.timestamp) return new Date(Number(record.timestamp) * 1000).toISOString();
  if (typeof record.actual_time === "number") return new Date(record.actual_time * 1000).toISOString();
  return String(record.actual_time || "");
}

function checkpointLocation(record) {
  return locationName(record.current_location) || locationName(record.next_location);
}

export default async function handler(req, res) {
  if (req.method === "OPTIONS") {
    Object.entries(corsHeaders()).forEach(([key, value]) => res.setHeader(key, value));
    return res.status(204).end();
  }

  Object.entries(corsHeaders()).forEach(([key, value]) => res.setHeader(key, value));
  const awb = String(req.query?.awb || "").trim();
  if (!awb) return res.status(400).json({ ok: false, error: "Missing AWB" });

  const timestamp = Math.floor(Date.now() / 1000);
  const signature = createHash("sha256").update(`${awb}${timestamp}${SPX_SALT}`).digest("hex");
  const trackingNumber = `${awb}|${timestamp}${signature}`;
  const url = `${SPX_BASE}/api/v2/fleet_order/tracking/search?sls_tracking_number=${encodeURIComponent(trackingNumber)}`;

  try {
    const response = await fetch(url, {
      headers: {
        accept: "application/json, text/plain, */*",
        "accept-language": "id-ID,id;q=0.9",
        referer: `${SPX_BASE}/m/tracking-detail/${encodeURIComponent(awb)}`,
        source: "mobile",
        "user-agent": "Mozilla/5.0 (Linux; Android 10; K) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Mobile Safari/537.36",
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
    const lastRecord = records[0] || {};
    if (!response.ok || payload?.retcode !== 0 || records.length === 0) {
      return res.status(response.ok ? 404 : response.status).json({
        ok: false,
        error: "SPX tracking number not found",
      });
    }

    const result = {
      resi: awb,
      waybill_id: awb,
      latest_status: lastRecord.status || lastRecord.tracking_name || lastRecord.description || data?.current_status || "Dalam proses",
      latest_checkpoint_date: checkpointTime(lastRecord) || data?.latest_checkpoint_date || "",
      latest_note: lastRecord.message || lastRecord.description || "",
      location: checkpointLocation(lastRecord),
      records: records.map((record) => ({
        actual_time: checkpointTime(record),
        status: String(record.status || record.tracking_name || ""),
        description: String(record.description || record.message || ""),
        location: checkpointLocation(record),
      })),
    };

    return res.status(200).json({ ok: true, result });
  } catch (error) {
    return res.status(502).json({ ok: false, error: "SPX API unavailable" });
  }
}
