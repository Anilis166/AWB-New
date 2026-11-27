// ═══════════════════════════════════════════════════════
// helpers.js — Port helper logic dari MainWindow.xaml.cs
// Status translation, date matching, destination matching, etc.
// ═══════════════════════════════════════════════════════

// ── Status translation map (EN → ID) ──
const BITESHIP_STATUS_MAP = [
  // 3 STATUS FOCUS (paling spesifik, duluan)
  ["order has been confirmed. locating nearest driver", "Pesanan dikonfirmasi — mencari kurir pickup"],
  ["order has been confirmed", "Pesanan dikonfirmasi"],
  ["locating nearest driver", "Mencari kurir pickup"],
  ["item has been picked and ready to be shipped", "Barang sudah dijemput — siap dikirim"],
  ["item has been picked", "Barang sudah dijemput"],
  ["ready to be shipped", "Siap dikirim"],
  ["paket gagal di pick up", "Paket gagal dijemput"],
  ["failed pick up", "Gagal dijemput"],

  // Delivered / final states
  ["item has been delivered", "Barang sudah diterima"],
  ["package delivered", "Paket diterima"],
  ["shipment delivered", "Paket diterima"],
  ["delivered to", "Diterima oleh"],
  ["received by", "Diterima oleh"],
  ["delivered", "Diterima"],

  // In-transit / active
  ["out for delivery", "Sedang diantar kurir"],
  ["on delivery", "Sedang diantar kurir"],
  ["with delivery courier", "Sedang diantar kurir"],
  ["courier assigned", "Kurir sudah ditugaskan"],
  ["in transit", "Dalam perjalanan"],
  ["on the way", "Dalam perjalanan"],
  ["arrived at destination", "Tiba di kota tujuan"],
  ["arrived at hub", "Tiba di gudang transit"],
  ["arrived at warehouse", "Tiba di gudang"],
  ["arrived at", "Tiba di"],
  ["departed from", "Berangkat dari"],
  ["in warehouse", "Di gudang"],
  ["at warehouse", "Di gudang"],
  ["at sorting center", "Di pusat sortir"],

  // Pickup / origin
  ["picked up by courier", "Paket diambil kurir"],
  ["has been picked up", "Sudah dijemput"],
  ["picked up", "Diambil kurir"],
  ["waiting for pickup", "Menunggu penjemputan"],
  ["waiting pickup", "Menunggu penjemputan"],
  ["ready to pickup", "Siap dijemput"],
  ["pickup requested", "Permintaan penjemputan"],

  // Manifest / confirmation
  ["shipment manifested", "Resi termanifest"],
  ["manifested", "Termanifest"],
  ["shipment created", "Resi dibuat"],
  ["order confirmed", "Pesanan dikonfirmasi"],
  ["order accepted", "Pesanan diterima sistem"],
  ["order created", "Pesanan dibuat"],
  ["order allocated", "Pesanan dialokasikan"],
  ["allocated", "Dialokasikan"],

  // Problem / negative states
  ["return to sender", "Retur ke pengirim"],
  ["returned to sender", "Retur ke pengirim"],
  ["returned", "Diretur"],
  ["failed delivery", "Gagal antar"],
  ["delivery failed", "Gagal antar"],
  ["cancelled", "Dibatalkan"],
  ["canceled", "Dibatalkan"],
  ["on hold", "Ditahan"],
  ["held", "Ditahan"],
  ["lost", "Hilang"],
  ["damaged", "Rusak"],

  // Generic / short
  ["scheduled", "Terjadwal"],
  ["pending", "Menunggu"],
  ["processed", "Diproses"],
  ["processing", "Sedang diproses"],
  ["confirmed", "Dikonfirmasi"],
  ["found", "Ditemukan"],
  ["unknown", "Tidak diketahui"],
];

const ID_MARKERS = ["paket ", "diterima", "diantar", "kurir", "pengirim", "tujuan", "gudang", "manifest", "terima", "diambil", "dikonfirmasi", "dibatalkan", "dijemput", "menunggu"];

export function translateBiteshipStatus(raw) {
  if (!raw) return "";
  const trimmed = raw.trim();
  const lower = trimmed.toLowerCase();

  // Skip if already looks Indonesian
  for (const m of ID_MARKERS)
    if (lower.includes(m)) return trimmed;

  // Phrase match, first match wins
  for (const [en, id] of BITESHIP_STATUS_MAP)
    if (lower.includes(en)) return id;

  return trimmed;
}

// ── Parse Biteship date ──
export function parseBiteshipDate(raw) {
  if (!raw || raw.trim() === "") return "";
  const fixed = raw.replace(/\./g, ":");
  const dto = new Date(fixed);
  if (!isNaN(dto)) {
    const y = dto.getFullYear();
    const m = String(dto.getMonth() + 1).padStart(2, "0");
    const d = String(dto.getDate()).padStart(2, "0");
    const h = String(dto.getHours()).padStart(2, "0");
    const min = String(dto.getMinutes()).padStart(2, "0");
    return `${y}-${m}-${d} ${h}:${min}`;
  }
  return "";
}

// ── Get history from Biteship response ──
export function getHistory(result) {
  return result?.history || result?.data?.tracking_history || [];
}

// ── Get latest history entry (sort by date DESC) ──
export function getLatestHistoryEntry(result) {
  const history = getHistory(result);
  if (!history || history.length === 0) return null;

  const parsed = [];
  for (const h of history) {
    const raw = h.updated_at || h.datetime || h.date || "";
    const dto = new Date(raw.replace(/\./g, ":"));
    if (!isNaN(dto)) parsed.push({ dto, entry: h });
  }
  if (parsed.length === 0) return history[history.length - 1];
  parsed.sort((a, b) => b.dto - a.dto);
  return parsed[0].entry;
}

// ── Get note or desc from history entry ──
export function getNoteOrDesc(entry) {
  return entry?.note ?? entry?.desc ?? entry?.description ?? "";
}

// ── Get date from history entry ──
export function getDateOrUpdated(entry) {
  return entry?.updated_at ?? entry?.date ?? entry?.datetime ?? "";
}

// ── Extract shipment date from result ──
export function extractShipmentDate(result) {
  for (const h of getHistory(result)) {
    const parsed = parseBiteshipDate(getDateOrUpdated(h));
    if (parsed) return parsed;
  }
  return "";
}

// ── Check if result is valid ──
export function isValidBiteshipResult(result) {
  if (!result || result.success !== true) return false;
  const histLen = (result.history?.length || 0) + (result.data?.tracking_history?.length || 0);
  return histLen > 0;
}

// ── Check if status is "baru cetak" (new print) ──
// RULE: lolos HANYA kalau entry PALING PERTAMA adalah "Order has been confirmed..."
// DAN tidak ada status lanjutan (picked/in transit/delivered).
// Artinya: resi ini baru di-cetak dan BELUM diproses sama sekali oleh kurir.
export function isNewPrintStatus(result) {
  const history = getHistory(result);
  if (!history || history.length === 0) return false;

  const entriesWithDto = [];
  for (const h of history) {
    const raw = getDateOrUpdated(h);
    const dto = new Date(raw.replace(/\./g, ":"));
    if (!isNaN(dto)) entriesWithDto.push({ dto, entry: h });
  }
  if (entriesWithDto.length === 0) return false;

  // ASC: entry paling awal duluan
  entriesWithDto.sort((a, b) => a.dto - b.dto);
  const firstEntry = entriesWithDto[0].entry;
  const note = (getNoteOrDesc(firstEntry) || "").toLowerCase().trim();

  // Entry pertama HARUS note confirmed (cek EN + ID, lengkap + short)
  const enPhrase = "order has been confirmed. locating nearest driver to pick up";
  const enShort = "order has been confirmed";
  const idPhrase = "pesanan dikonfirmasi — mencari kurir pickup";
  const idShort = "pesanan dikonfirmasi";
  const isConfirmed = note.includes(enPhrase) || note.includes(enShort) ||
                      note.includes(idPhrase) || note.includes(idShort);
  if (!isConfirmed) return false;

  // Cek entry LANJUTAN: kalau ada pickup/in-transit/delivered → BUKAN new print
  for (let i = 1; i < entriesWithDto.length; i++) {
    const laterNote = (getNoteOrDesc(entriesWithDto[i].entry) || "").toLowerCase().trim();
    if (laterNote.includes("picked") || laterNote.includes("diambil") || laterNote.includes("di pickup") ||
        laterNote.includes("pick up") || laterNote.includes("gagal di pick") ||
        laterNote.includes("in transit") || laterNote.includes("dalam perjalanan") || laterNote.includes("diantar") ||
        laterNote.includes("delivered") || laterNote.includes("diterima") || laterNote.includes("terima")) {
      return false; // sudah diproses kurir
    }
  }

  return true; // hanya confirmed, tanpa status lanjutan = BARU CETAK
}

// ── Date matching ──
// FIX 2026-07-22: cek SEMUA entry history (bukan cuma 1). Match kalo ADA
// entry yg tanggalnya cocok + jam masuk range. Ini nutup 2 bug:
//   1. Biteship return history urutan tertua→terbaru — loop lama ambil index
//      terakhir yg dipikir "cetak awal" padahal itu justru terbaru.
//   2. Filter jam terlalu strict — kalau target 11:00-13:00 tapi confirmed
//      10:58, ditolak padahal cuma miss 2 menit. Sekarang pake toleransi.
const TIME_TOLERANCE_MIN = 5; // ±5 menit toleransi (naik dari 2 — Biteship timestamp sering delay)

export function dateMatches(result, targetDate, timeRange) {
  const histories = getHistory(result);
  if (!histories || histories.length === 0)
    return dateMatchesSingle(extractShipmentDate(result), targetDate, timeRange);

  // Cek SEMUA entry — return true kalau ada satu yg cocok tanggal+jam
  for (const h of histories) {
    const raw = getDateOrUpdated(h);
    const ts = parseBiteshipDate(raw);
    if (ts && dateMatchesSingle(ts, targetDate, timeRange)) return true;
  }
  return false;
}

function dateMatchesSingle(ts, targetDate, timeRange) {
  if (!ts || ts.length < 10) return false;
  if (ts.substring(0, 10) !== targetDate) return false;
  if (!timeRange) return true;
  if (ts.length < 16) return false;
  const minutes = parseInt(ts.substring(11, 13)) * 60 + parseInt(ts.substring(14, 16));
  if (isNaN(minutes)) return false;
  // FIXED: toleransi ±TIME_TOLERANCE_MIN di START DAN END.
  // Biteship suka telat update — status "11:05" bisa tercatat jam 11:08 kalau prosesnya mepet.
  // Kalo user target 11:00-13:00, jam 10:58 tetap masuk (toleransi 10 min).
  // Jam 13:10 juga masuk (toleransi 10 min di end).
  return (minutes + TIME_TOLERANCE_MIN) >= timeRange.start &&
         (minutes - TIME_TOLERANCE_MIN) <= timeRange.end;
}

// ── Extract matching date ──
export function extractMatchingDate(result, targetDate, timeRange) {
  const histories = getHistory(result);
  // Urutkan dari yang TERLAMA — supaya jam awal range diprioritasin
  const sorted = [...histories].sort((a, b) => {
    const tsA = parseBiteshipDate(getDateOrUpdated(a));
    const tsB = parseBiteshipDate(getDateOrUpdated(b));
    return tsA.localeCompare(tsB);
  });
  // Cari yang match exact dulu (tanpa toleransi)
  for (const h of sorted) {
    const ts = parseBiteshipDate(getDateOrUpdated(h));
    if (ts && dateMatchesSingleExact(ts, targetDate, timeRange)) return ts;
  }
  // Fallback ke yang match dengan toleransi
  for (const h of sorted) {
    const ts = parseBiteshipDate(getDateOrUpdated(h));
    if (dateMatchesSingle(ts, targetDate, timeRange)) return ts;
  }
  return sorted[0] ? parseBiteshipDate(getDateOrUpdated(sorted[0])) : "";
}

// Version exact tanpa toleransi — untuk prioritas matching
function dateMatchesSingleExact(ts, targetDate, timeRange) {
  if (!ts || ts.length < 10) return false;
  if (ts.substring(0, 10) !== targetDate) return false;
  if (!timeRange) return true;
  if (ts.length < 16) return false;
  const minutes = parseInt(ts.substring(11, 13)) * 60 + parseInt(ts.substring(14, 16));
  if (isNaN(minutes)) return false;
  return minutes >= timeRange.start && minutes <= timeRange.end;
}

// ── Time range parsing ──
export function parseTimeRange(input) {
  if (!input || input.trim() === "") return null;
  const parts = input.split("-").map(s => s.trim());
  if (!tryParseMinutes(parts[0])) return null;
  const start = tryParseMinutes(parts[0]);
  const endText = parts.length > 1 ? parts[1] : parts[0];
  if (!tryParseMinutes(endText)) return null;
  const end = tryParseMinutes(endText);
  return { start: Math.min(start, end), end: Math.max(start, end) };
}

function tryParseMinutes(input) {
  const m = (input || "").trim().match(/^(\d{2}):(\d{2})$/);
  if (!m) return null;
  const hour = parseInt(m[1]);
  const minute = parseInt(m[2]);
  if (hour > 23 || minute > 59) return null;
  return hour * 60 + minute;
}

// ── Build destination string ──
export function buildDestination(result) {
  const loc = result?.destination || result?.data?.destination;
  if (!loc) return "";
  const district = loc.district || loc.district_name || "";
  const city = loc.city || loc.city_name || "";
  if (district && city) return toTitle(district) + ", " + cleanCity(city);
  if (district) return toTitle(district);
  const address = loc.address || "";
  if (address) {
    const stripped = stripContact(address, loc.contact_name || "");
    const parts = stripped.split(",").map(s => s.trim());
    if (parts.length === 2) return toTitle(parts[0]) + ", " + cleanCity(parts[1]);
    return cleanCity(address);
  }
  return cleanCity(city);
}

function stripContact(address, contact) {
  if (contact && address.toLowerCase().startsWith(contact.toLowerCase()))
    return address.substring(contact.length).trim();
  return address.trim();
}

export function cleanCity(value) {
  let c = (value || "").trim();
  for (const prefix of ["KOTA ADMINISTRASI ", "KOTA ", "KAB. ", "KAB ", "KABUPATEN "]) {
    if (c.toUpperCase().startsWith(prefix)) { c = c.substring(prefix.length); break; }
  }
  return toTitle(c);
}

function toTitle(value) {
  return value.trim().toLowerCase().replace(/\b\w/g, c => c.toUpperCase());
}

// ── Build origin string ──
export function buildOrigin(result) {
  const loc = result?.origin || result?.data?.origin;
  if (!loc) return "-";
  const city = loc.city || loc.city_name || loc.district || loc.district_name || loc.address || "";
  return city ? city.toUpperCase() : "-";
}

// ── Destination matching (fuzzy) ──
// ── Abbreviation/alias expansion for destination matching ──
const AREA_ALIASES = {
  "jaksel": "jakarta selatan", "jaktim": "jakarta timur", "jakbar": "jakarta barat",
  "jakpus": "jakarta pusat", "jakut": "jakarta utara", "jkt": "jakarta",
  "sby": "surabaya", "bdg": "bandung", "smg": "semarang", "solo": "surakarta",
  "jogja": "yogyakarta", "yogya": "yogyakarta", "diy": "yogyakarta",
  "mdn": "medan", "mks": "makassar", "ujung pandang": "makassar",
  "plg": "palembang", "pkb": "pekanbaru", "bpn": "balikpapan",
  "btm": "batam", "pdg": "padang", "mlg": "malang",
  "tangsel": "tangerang selatan", "depok": "depok",
  "bekasi": "bekasi", "tng": "tangerang",
};

function expandAbbreviations(value) {
  if (!value) return "";
  let result = value.toLowerCase().trim();
  // Replace whole-word abbreviations
  for (const [abbr, full] of Object.entries(AREA_ALIASES)) {
    const re = new RegExp("\\b" + abbr.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + "\\b", "gi");
    result = result.replace(re, full);
  }
  return result;
}

// ── Provinsi → daftar kabupaten/kota (untuk matching provinsi) ──
const PROVINCE_DISTRICTS = {
  "jawa timur": [
    "surabaya", "malang", "kediri", "madiun", "mojokerto", "pasuruan", "probolinggo", "batu",
    "gresik", "sidoarjo", "lamongan", "tuban", "bojonegoro", "ngawi", "magetan", "ponorogo",
    "pacitan", "trenggalek", "tulungagung", "blitar", "lumajang", "jember", "banyuwangi",
    "bondowoso", "situbondo", "bangkalan", "sampang", "pamekasan", "sumenep", "nganjuk",
    "bangil", "daun", "sukowidi", "nguntoronadi"
  ],
  "jawa barat": [
    "bandung", "bekasi", "depok", "bogor", "cirebon", "sukabumi", "tasikmalaya", "banjar",
    "cimahi", "garut", "purwakarta", "subang", "indramayu", "kuningan", "majalengka",
    "sumedang", "cianjur", "sukabumi", "ciamis", "pangandaran"
  ],
  "jawa tengah": [
    "semarang", "surakarta", "salatiga", "pekalongan", "tegal", "magelang",
    "cilacap", "banyumas", "purbalingga", "banjarnegara", "kebumen", "purworejo",
    "wonosobo", "magelang", "boyolali", "klaten", "sukoharjo", "wonogiri",
    "karanganyar", "sragen", "grobogan", "blora", "rembang", "pati", "kudus",
    "jepara", "demak", "semarang", "kendal", "batang", "pekalongan", "pemalang",
    "tegal", "brebes"
  ],
  "banten": [
    "serang", "cirebon", "tangerang", "serang", "lebak", "pandeglang", "tangerang selatan"
  ],
  "dki jakarta": [
    "jakarta pusat", "jakarta utara", "jakarta timur", "jakarta selatan", "jakarta barat",
    "kepulauan seribu"
  ],
  "di yogyakarta": [
    "yogyakarta", "sleman", "bantul", "gunung kidul", "kulon progo"
  ],
  "sumatera utara": [
    "medan", "binjai", "tebing tinggi", "pematang siantar", "tanjung balai", "sibolga",
    "padang sidempuan", "gunung sitoli", "deli serdang", "langkat", "karo", "simalungun",
    "asahan", "labuhanbatu", "tapanuli", "nias", "samosir", "toba"
  ],
  "sumatera barat": [
    "padang", "bukittinggi", "payakumbuh", "solok", "sawahlunto", "pariaman",
    "agam", "tanah datar", "pesisir selatan", "sijunjung", "dharmasraya", "lima puluh kota"
  ],
  "sumatera selatan": [
    "palembang", "prabumulih", "pagar alam", "lubuklinggau",
    "ogan komering ilir", "ogan komering ulu", "muara enim", "lahat", "musi rawas",
    "banyuasin", "empat lawang"
  ],
  "riau": [
    "pekanbaru", "dumai", "kampar", "bengkalis", "indragiri", "siak", "rokan",
    "kuantan singingi", "pelalawan"
  ],
  "kepulauan riau": [
    "batam", "tanjung pinang", "bintan", "karimun", "lingga", "natuna", "anambas"
  ],
  "kalimantan timur": [
    "samarinda", "balikpapan", "bontang", "kutai kartanegara", "kutai barat",
    "kutai timur", "berau", "paser", "penajam paser utara", "mahakam ulu"
  ],
  "kalimantan selatan": [
    "banjarmasin", "banjarbaru", "banjar", "tanah laut", "tanah bumbu",
    "kotabaru", "hulu sungai", "tabalong", "barito kuala"
  ],
  "sulawesi selatan": [
    "makassar", "pare pare", "palopo", "maros", "gowa", "takalar", "bone",
    "wajo", "soppeng", "barru", "pangkep", "pinrang", "enrekang", "luwu",
    "tana toraja", "bulukumba", "sinjai", "bantaeng", "jeneponto", "selayar"
  ],
  "bali": [
    "denpasar", "badung", "gianyar", "tabanan", "klungkung", "bangli",
    "karangasem", "buleleng", "jembrana"
  ],
  "nusa tenggara barat": [
    "mataram", "bima", "lombok", "sumbawa", "dompu"
  ],
  "lampung": [
    "bandar lampung", "metro", "lampung selatan", "lampung tengah", "lampung utara",
    "lampung timur", "lampung barat", "tanggamus", "pringsewu", "pesawaran",
    "way kanan", "tulang bawang", "mesuji"
  ]
};

export function matchDestination(entryDestRaw, targetAreaRaw) {
  if (!entryDestRaw) return false;
  if (!targetAreaRaw) return true; // kota kosong = skip filter kota
  // Expand abbreviations before tokenizing
  const expandedDest = expandAbbreviations(entryDestRaw);
  const expandedTarget = expandAbbreviations(targetAreaRaw);
  const destTokens = tokenList(expandedDest);
  const targetTokens = tokenList(expandedTarget);
  if (targetTokens.length === 0) return false;

  // ── Province mode: kalau target adalah nama provinsi ──
  const targetLower = expandedTarget.toLowerCase().trim();
  for (const [province, districts] of Object.entries(PROVINCE_DISTRICTS)) {
    if (targetLower === province || targetLower === "provinsi " + province) {
      // Skip direction check, match kalau dest mengandung salah satu kabupaten di provinsi
      const destLower = entryDestRaw.toLowerCase();
      for (const district of districts) {
        if (destLower.includes(district)) return true;
      }
      // Fallback aman: cek apakah dest mengandung KEDUA token provinsi
      // "Jawa Timur" → dest harus ada "jawa" DAN "timur"
      // Biar "Jakarta Timur" gak match (ada "timur" tapi gak ada "jawa")
      const provinceTokens = province.split(" ");
      const allMatch = provinceTokens.every(t => destLower.includes(t));
      return allMatch;
    }
  }

  const directions = ["selatan", "utara", "timur", "barat", "pusat"];
  const targetDirections = targetTokens.filter(t => directions.includes(t));

  if (targetDirections.length > 0) {
    // Kalau user ngetik "selatan", pastikan API (destTokens) juga ada kata "selatan" ATAU kalau destTokens kosong ya skip aja
    for (const dir of targetDirections) {
      if (destTokens.length > 0 && !destTokens.includes(dir)) {
        // Coba cek singkatan misal "sel" untuk "selatan"
        const abbr = dir.substring(0, 3);
        if (!destTokens.some(d => d.includes(abbr))) return false;
      }
    }
  }

  let matches = 0;
  for (const token of targetTokens) {
    if (destTokens.includes(token)) { matches++; continue; }
    // FIXED: threshold 0.76 — "magetan" vs "magelang" = 0.75 (beda kota, harus reject)
    // Naik dari 0.65 biar gak terlalu longgar. "cengkareng" vs "cengkareng jaya"
    // tetep match karena tokenization pisah, bukan fuzzy.
    const best = destTokens.length === 0 ? 0 : Math.max(...destTokens.map(d => similarity(token, d)));
    if (best >= 0.76) matches++; 
  }
  
  // FIXED: relaxed threshold — jika target "Jakarta Barat", dan API return "Jakarta Barat Administrasi",
  // token "barat" sudah match, token "jakarta" sudah match → matches=2, targetTokens=2 → lulus.
  // TAPI jika API return "Jakarta Selatan", token "barat" no-match tapi "jakarta" match → matches=1,
  // targetTokens=2 → reject. Ini sudah benar.
  // Namun untuk kasus "Cengkareng" vs "Cengkareng, Jakarta Barat", target="Cengkareng", API="Cengkareng, Jakarta Barat"
  // → token target=["cengkareng"], token dest=["cengkareng","jakarta","barat"] → matches=1, targetTokens=1 → LULUS.
  // FIXED: gunakan >= bukan > untuk lebih toleran
  return matches >= targetTokens.length;
}

function tokenList(value) {
  return normalizeAreaForMatch(value).split(" ").filter(s => s.length > 0);
}

function normalizeAreaForMatch(value) {
  const normalized = (value || "").toLowerCase().replace(/[^0-9a-zA-Z\s]+/g, " ");
  const stopWords = ["kota", "kab", "kabupaten", "administrasi", "kec", "kecamatan", "kelurahan", "kel", "desa", "ds", "rt", "rw", "provinsi", "prov"];
  const tokens = normalized.replace(/\s+/g, " ").trim().split(" ").filter(t => !stopWords.includes(t));
  return tokens.join(" ");
}

function similarity(a, b) {
  if (a === b) return 1.0;
  if (!a || !b) return 0.0;
  const dist = levenshtein(a, b);
  return 1.0 - (dist / Math.max(a.length, b.length));
}

function levenshtein(a, b) {
  const dp = Array(a.length + 1).fill(0).map(() => Array(b.length + 1).fill(0));
  for (let i = 0; i <= a.length; i++) dp[i][0] = i;
  for (let j = 0; j <= b.length; j++) dp[0][j] = j;
  for (let i = 1; i <= a.length; i++)
    for (let j = 1; j <= b.length; j++)
      dp[i][j] = Math.min(dp[i-1][j] + 1, dp[i][j-1] + 1, dp[i-1][j-1] + (a[i-1] === b[j-1] ? 0 : 1));
  return dp[a.length][b.length];
}

// ── Extract city key from destination string ──
export function extractCityKey(targetArea) {
  if (!targetArea) return "";
  const parts = targetArea.split(",").map(s => s.trim()).filter(s => s.length > 0);
  let city = parts.length >= 2 ? parts[parts.length - 1] : targetArea;
  for (const prefix of ["KOTA ADMINISTRASI ", "KOTA ", "KAB. ", "KAB ", "KABUPATEN "]) {
    if (city.toUpperCase().startsWith(prefix)) { city = city.substring(prefix.length); break; }
  }
  return normalizeKey(cleanCity(city));
}

export function normalizeKey(value) {
  const normalized = (value || "").toLowerCase().replace(/[^0-9a-zA-Z\s]+/g, " ");
  return normalized.replace(/\s+/g, " ").trim();
}

// ── Diagnostic helper ──
export function getBiteshipDiag(result) {
  const histories = getHistory(result);
  if (!histories || histories.length === 0) return "tanpa-histori";
  const dtos = [];
  for (const h of histories) {
    const raw = getDateOrUpdated(h);
    const dto = new Date(raw.replace(/\./g, ":"));
    if (!isNaN(dto)) dtos.push(dto);
  }
  let earliest = "", latest = "";
  if (dtos.length > 0) {
    const min = new Date(Math.min(...dtos));
    const max = new Date(Math.max(...dtos));
    earliest = formatDateTime(min);
    latest = formatDateTime(max);
  } else {
    const firstRaw = getDateOrUpdated(histories[0]);
    const parsed = parseBiteshipDate(firstRaw);
    earliest = latest = parsed;
  }
  const lastEntry = getLatestHistoryEntry(result);
  const lastNote = getNoteOrDesc(lastEntry) || "";
  return `awal=${earliest} akhir=${latest} catatan=${lastNote}`;
}

function formatDateTime(dto) {
  const y = dto.getFullYear();
  const m = String(dto.getMonth() + 1).padStart(2, "0");
  const d = String(dto.getDate()).padStart(2, "0");
  const h = String(dto.getHours()).padStart(2, "0");
  const min = String(dto.getMinutes()).padStart(2, "0");
  return `${y}-${m}-${d} ${h}:${min}`;
}

// ── Create result row from Biteship response ──
export function buildDestinationAddress(result) {
  const loc = result.destination || result.data?.destination;
  if (!loc) return "-";
  const district = loc.district || loc.district_name || "";
  const city = loc.city || loc.city_name || "";
  if (district && city) return toTitle(district) + ", " + cleanCity(city);
  return loc.address || "-";
}

export function createBiteshipRow(awb, result, targetDate, timeRange) {
  const history = getHistory(result);
  const latestEntry = getLatestHistoryEntry(result);
  const displayDate = latestEntry ? parseBiteshipDate(getDateOrUpdated(latestEntry)) : "";
  const destination = buildDestination(result);
  const status = translateBiteshipStatus(
    getNoteOrDesc(latestEntry) || result.status || result.data?.status || "Ditemukan"
  );

  return {
    awb: result.waybill_id || awb,
    status,
    receiver: result.destination?.contact_name || result.data?.receiver_name || "-",
    destination: destination || "-",
    lastUpdate: displayDate + " - " + status,
    jam: displayDate.length >= 16 ? displayDate.substring(11, 16) : "-",
    tanggal: displayDate.length >= 10 ? displayDate.substring(0, 10) : "-",
    courier: result.courier?.company || result.data?.courier?.company || "sicepat",
    sender: result.origin?.contact_name || result.data?.origin?.contact_name || "-",
    senderAddress: buildOrigin(result),
    receiverAddress: buildDestinationAddress(result),
    history: history.map(h => ({
      date: parseBiteshipDate(getDateOrUpdated(h)),
      description: translateBiteshipStatus(getNoteOrDesc(h)),
      location: h.city_name || ""
    }))
  };
}

// ── Create result row from Binderbyte response ──
export function createBinderbyteRow(awb, result) {
  const summary = result?.data?.summary;
  const detail = result?.data?.detail;
  const allHistory = result?.data?.history || [];

  // Translate all history descriptions
  for (const h of allHistory) h.desc = translateBiteshipStatus(h.desc);

  // Get latest entry
  const validHistory = allHistory.filter(h => h.date);
  validHistory.sort((a, b) => (b.date || "").localeCompare(a.date || ""));
  const latest = validHistory[0];

  let jam = "-", tanggal = "-";
  if (latest?.date) {
    const dt = new Date(latest.date);
    if (!isNaN(dt)) {
      jam = String(dt.getHours()).padStart(2, "0") + ":" + String(dt.getMinutes()).padStart(2, "0");
      tanggal = formatTanggalIndo(dt);
    }
  } else if (summary?.date) {
    const dt = new Date(summary.date);
    if (!isNaN(dt)) {
      jam = String(dt.getHours()).padStart(2, "0") + ":" + String(dt.getMinutes()).padStart(2, "0");
      tanggal = formatTanggalIndo(dt);
    }
  }

  return {
    awb: summary?.awb || awb,
    status: translateBiteshipStatus(latest?.desc || summary?.status || "Tidak diketahui"),
    receiver: detail?.receiver || "-",
    destination: detail?.destination || "-",
    lastUpdate: latest ? (latest.date + " — " + latest.desc) : (summary?.date || "-"),
    jam,
    tanggal,
    courier: summary?.courier || "sicepat",
    history: allHistory.map(h => ({
      date: h.date || "",
      description: translateBiteshipStatus(h.desc || ""),
      location: h.location || ""
    }))
  };
}

function formatTanggalIndo(dt) {
  const hari = ["Minggu", "Senin", "Selasa", "Rabu", "Kamis", "Jumat", "Sabtu"];
  const bulan = ["Januari", "Februari", "Maret", "April", "Mei", "Juni",
                 "Juli", "Agustus", "September", "Oktober", "November", "Desember"];
  return `${hari[dt.getDay()]}, ${dt.getDate()} ${bulan[dt.getMonth()]} ${dt.getFullYear()}`;
}

// ── Escape XML for Excel export ──
export function escapeXml(value) {
  return (value || "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

