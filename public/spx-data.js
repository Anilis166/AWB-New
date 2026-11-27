export const normalizeResi = (value) => String(value ?? "").trim().toUpperCase();

export function parseSpxAwbList(value) {
  const awbs = new Map();
  for (const rawAwb of String(value ?? "").split(/[\s,;]+/)) {
    const resi = normalizeResi(rawAwb);
    if (resi && !awbs.has(resi)) awbs.set(resi, resi);
  }
  return [...awbs.values()];
}

export function parseSpxCandidateRows(text) {
  const content = String(text ?? "").trim();
  if (!content) return [];

  let rows;
  try {
    const data = JSON.parse(content);
    if (Array.isArray(data)) {
      rows = data;
    } else if (data && typeof data === "object") {
      const candidates = data.candidates ?? data.records ?? data.valid ?? data.data;
      rows = Array.isArray(candidates) ? candidates : [data];
    } else {
      throw new Error("Data harus berupa daftar AWB JSON atau JSONL.");
    }
  } catch (jsonError) {
    rows = content.split(/\r?\n/).filter((line) => line.trim()).map((line, index) => {
      try {
        return JSON.parse(line);
      } catch (lineError) {
        const awb = line.trim();
        if (/^[A-Za-z0-9-]+$/.test(awb)) return awb;
        throw new Error(`Baris ${index + 1} tidak valid: ${lineError.message || jsonError.message}`);
      }
    });
  }

  const candidates = new Map();
  for (const row of rows) {
    const value = typeof row === "string" ? row : row?.resi ?? row?.waybill_id ?? row?.awb;
    const resi = normalizeResi(value);
    if (!resi) continue;
    const date = typeof row === "object" && row ? String(row.date ?? "") : "";
    const previous = candidates.get(resi);
    if (!previous || date > previous.date) candidates.set(resi, { resi, date });
  }
  return [...candidates.values()];
}

export function filterSpxCandidateRows(candidates, dateFilter, timeRange) {
  return candidates.filter(({ date }) => {
    if (!date) return true;
    if (!date.startsWith(dateFilter)) return false;
    if (!timeRange) return true;
    const match = date.match(/T(\d{2}):(\d{2})| (\d{2}):(\d{2})/);
    if (!match) return true;
    const hour = Number(match[1] ?? match[3]);
    const minute = Number(match[2] ?? match[4]);
    const minutes = hour * 60 + minute;
    return minutes >= timeRange.start && minutes <= timeRange.end;
  });
}

export function formatSpxAwb(value) {
  const resi = normalizeResi(value);
  if (!resi || resi.startsWith("SPXID")) return resi;
  return `SPXID${resi.replace(/B$/, "")}B`;
}

export function buildSpxResult(awb, tracking) {
  const resi = normalizeResi(awb);
  const entry = tracking.get(resi);
  const latestDate = entry?.latest_checkpoint_date ?? "";
  const dateMatch = latestDate.match(/(\d{4}-\d{2}-\d{2})/);
  const timeMatch = latestDate.match(/(?:T|\s)(\d{2}:\d{2})/);

  return {
    awb: entry?.waybill_id ?? awb,
    status: entry?.latest_status || "Tidak ditemukan",
    receiver: entry?.latest_note || "-",
    destination: entry?.location || "-",
    lastUpdate: latestDate || "-",
    jam: timeMatch?.[1] ?? "-",
    tanggal: dateMatch?.[1] ?? "-",
    courier: "SPX",
    sender: "-",
    senderAddress: "-",
    receiverAddress: entry?.location || "-",
    history: entry?.records?.map((record) => ({
      date: String(record.actual_time ?? ""),
      description: String(record.tracking_name ?? record.status ?? record.description ?? record.message ?? ""),
      location: String(record.current_location ?? record.next_location ?? ""),
    })) ?? [],
  };
}
