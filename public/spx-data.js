export const normalizeResi = (value) => String(value ?? "").trim().toUpperCase();

export function parseSpxAwbList(value) {
  const awbs = new Map();
  for (const rawAwb of String(value ?? "").split(/[\s,;]+/)) {
    const resi = normalizeResi(rawAwb);
    if (resi && !awbs.has(resi)) awbs.set(resi, resi);
  }
  return [...awbs.values()];
}

export function formatSpxAwb(value) {
  const resi = normalizeResi(value);
  if (!resi || resi.startsWith("SPXID")) return resi;
  return `SPXID${resi.replace(/B$/, "")}B`;
}

function formatSpxDateTime(value) {
  if (!value) return null;
  const raw = typeof value === "number" ? new Date(value * 1000) : String(value);
  const date = raw instanceof Date
    ? raw
    : new Date(
        !/(?:Z|[+-]\d{2}:?\d{2})$/i.test(raw) && /^\d{4}-\d{2}-\d{2}[T ]/.test(raw)
          ? `${raw.replace(" ", "T")}+07:00`
          : raw,
      );
  if (Number.isNaN(date.getTime())) return null;

  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Jakarta",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).formatToParts(date);
  const part = (type) => parts.find((value) => value.type === type)?.value || "";
  return {
    date: `${part("year")}-${part("month")}-${part("day")}`,
    time: `${part("hour")}:${part("minute")}`,
  };
}

function checkpointLocation(record) {
  const location = record.location ?? record.current_location ?? record.next_location;
  if (typeof location === "string") return location;
  return location?.location_name || location?.name || "";
}

export function buildSpxResult(awb, tracking) {
  const resi = normalizeResi(awb);
  const entry = tracking.get(resi);
  const latestDate = entry?.latest_checkpoint_date ?? "";
  const latestDateTime = formatSpxDateTime(latestDate);

  return {
    awb: entry?.waybill_id ?? awb,
    status: entry?.latest_status || "Tidak ditemukan",
    receiver: "-",
    trackingNote: entry?.latest_note || "-",
    destination: entry?.location || "-",
    lastUpdate: latestDateTime ? `${latestDateTime.date} ${latestDateTime.time}` : latestDate || "-",
    jam: latestDateTime?.time ?? "-",
    tanggal: latestDateTime?.date ?? "-",
    courier: "SPX",
    sender: "-",
    senderAddress: "-",
    receiverAddress: "-",
    history: entry?.records?.map((record) => {
      const dateTime = formatSpxDateTime(record.actual_time);
      return {
        date: dateTime ? `${dateTime.date} ${dateTime.time}` : String(record.actual_time ?? ""),
        description: String(record.description || record.status || record.tracking_name || record.message || ""),
        location: checkpointLocation(record),
      };
    }) ?? [],
  };
}
