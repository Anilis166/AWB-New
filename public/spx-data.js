export const normalizeResi = (value) => String(value ?? "").trim().toUpperCase();

export function filterSpxCandidates(candidates, dateFilter, timeRange) {
  if (!/^\d{4}-\d{2}(?:-\d{2})?$/.test(dateFilter)) return [];
  return [...candidates.values()].filter((candidate) => {
    const date = String(candidate.date ?? "");
    if (!date.startsWith(dateFilter)) return false;
    if (!timeRange) return true;
    const match = date.match(/T(\d{2}):(\d{2})| (\d{2}):(\d{2})/);
    if (!match) return false;
    const hour = Number(match[1] ?? match[3]);
    const minute = Number(match[2] ?? match[4]);
    const minutes = hour * 60 + minute;
    return minutes >= timeRange.start && minutes <= timeRange.end;
  });
}

function rowEntries(rows) {
  const entries = new Map();
  for (const row of rows) {
    if (!row || typeof row !== "object" || Array.isArray(row)) continue;
    const resi = normalizeResi(row.resi ?? row.waybill_id ?? row.awb);
    if (!resi) continue;
    const date = String(row.date ?? "");
    const previous = entries.get(resi);
    if (!previous || date > previous.date) entries.set(resi, { ...row, date });
  }
  return entries;
}

export function parseSpxCandidates(text) {
  let data;
  try {
    data = JSON.parse(String(text ?? ""));
  } catch {
    const rows = [];
    for (const [index, line] of String(text ?? "").split(/\r?\n/).entries()) {
      if (!line.trim()) continue;
      try {
        rows.push(JSON.parse(line));
      } catch (error) {
        throw new Error(`JSONL tidak valid pada baris ${index + 1}: ${error.message}`);
      }
    }
    return rowEntries(rows);
  }

  const rows = Array.isArray(data) ? data : data?.candidates ?? data?.records;
  if (!Array.isArray(rows)) throw new Error("Data kandidat harus berupa array JSON atau JSONL.");
  return rowEntries(rows);
}

export function parseSpxTracking(text) {
  let data;
  try {
    data = JSON.parse(String(text ?? ""));
  } catch (error) {
    throw new Error(`File hasil tracking bukan JSON yang valid: ${error.message}`);
  }
  const rows = Array.isArray(data) ? data : [data];
  const entries = new Map();
  for (const row of rows) {
    if (!row || typeof row !== "object" || Array.isArray(row)) continue;
    const resi = normalizeResi(row.waybill_id ?? row.awb ?? row.resi);
    if (!resi) continue;
    const records = Array.isArray(row.records) ? row.records : [];
    const lastRecord = records[records.length - 1] ?? {};
    const entry = {
      ...row,
      resi,
      latest_status: String(row.latest_status ?? row.status ?? ""),
      latest_checkpoint_date: String(row.latest_checkpoint_date ?? row.latest_date ?? row.date ?? lastRecord.actual_time ?? ""),
      latest_note: String(row.latest_note ?? row.first_checkpoint_note ?? lastRecord.description ?? ""),
      location: String(
        lastRecord.current_location?.location_name ??
        lastRecord.current_location ??
        lastRecord.next_location?.location_name ??
        lastRecord.next_location ??
        "",
      ),
      records,
    };
    const previous = entries.get(resi);
    if (!previous || entry.latest_checkpoint_date >= previous.latest_checkpoint_date) {
      entries.set(resi, entry);
    }
  }
  return entries;
}

export function buildSpxResult(awb, candidates, tracking) {
  const resi = normalizeResi(awb);
  const candidate = candidates.get(resi);
  const entry = tracking.get(resi);
  const latestDate = entry?.latest_checkpoint_date ?? "";
  const dateMatch = latestDate.match(/(\d{4}-\d{2}-\d{2})/);
  const timeMatch = latestDate.match(/(?:T|\s)(\d{2}:\d{2})/);

  return {
    awb: entry?.waybill_id ?? candidate?.resi ?? awb,
    status: entry?.latest_status || (candidate ? "Belum ada status" : "Tidak ditemukan"),
    receiver: entry?.latest_note || "-",
    destination: entry?.location || "-",
    lastUpdate: latestDate || candidate?.date || "-",
    jam: timeMatch?.[1] ?? "-",
    tanggal: dateMatch?.[1] ?? candidate?.date ?? "-",
    courier: "SPX",
    sender: "-",
    senderAddress: "-",
    receiverAddress: entry?.location || "-",
    history: entry?.records.map((record) => ({
      date: String(record.actual_time ?? ""),
      description: String(record.tracking_name ?? record.status ?? record.description ?? record.message ?? ""),
      location: String(record.current_location ?? record.next_location ?? ""),
    })) ?? [],
  };
}
