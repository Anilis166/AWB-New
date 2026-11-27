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
