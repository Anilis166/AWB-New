// ═══════════════════════════════════════════════════════
// app.js — Main application logic
// Port dari MainWindow.xaml.cs ke browser JS
// ═══════════════════════════════════════════════════════

import { AwbMlEngine, spiralOrder, normalizeKey, extractCityKey } from "./ml-engine.js";
import {
  translateBiteshipStatus, parseBiteshipDate, getHistory, getLatestHistoryEntry,
  getNoteOrDesc, getDateOrUpdated, extractShipmentDate, isValidBiteshipResult,
  isNewPrintStatus, dateMatches, extractMatchingDate, parseTimeRange,
  buildDestination, buildOrigin, matchDestination, getBiteshipDiag,
  createBiteshipRow, escapeXml, cleanCity
} from "./helpers.js";
import { getGuestUser } from "./guest.js?v=20261127063315";
import {
  buildSpxResult,
  filterSpxCandidates,
  normalizeResi,
  parseSpxCandidates,
  parseSpxTracking,
} from "./spx-data.js";

// ── Constants ──
const PREFIX = "0046";
const FIXED_FIELD = "0000";
let COURIER = "sicepat";
const MAX_CONCURRENT = 32;  // match desktop tool (32 threads)
const SAVE_EVERY = 100;

// ── State ──
let results = [];
let spxCandidates = new Map();
let spxTracking = new Map();
let cts = null; // { cancelled: false }
let _paused = false; // true = pause (keep scan UI), false = stop/reset
let nextResolver = null;
let startTime = null;
let ml = null;
let settings = { theme: "JINX", speedMultiplier: 2, hideAwbColumn: false, sortByTime: false, newPrintOnly: true, realtimeAggr: false };
let logQueue = [];
let logRafId = null;
let progress = null; // { phase, checkedMids, checkedAreas, foundMid, ... }
let renderPending = false;
let renderTimer = null;
let visitedAwbSuffix = new Set(); // dedup: skip AWB suffix yg sudah pernah di-cek
let copiedAwbs = new Set();      // track AWB yg sudah disalin (persistent)
let _rateTokens = 10;            // DEPRECATED: kept for batch track mode only
const BASE_WORKER_DELAY_MS = 50;  // Base delay, divided by speedMultiplier

// ═══════════════════════════════════════════════════════
// SPLASH / LOADING SCREEN
// Port dari LoadingWindow.xaml — 22-seg bar, shimmer, status
// ═══════════════════════════════════════════════════════
const SPLASH_SEG_COUNT = 22;
let _splashShimmerPos = 0;
let _splashLastSegCount = -1;
let _splashShimmerTimer = null;
let _splashSegs = [];

function initSplash() {
  const segbar = document.getElementById("splashSegbar");
  if (!segbar) return;
  for (let i = 0; i < SPLASH_SEG_COUNT; i++) {
    const seg = document.createElement("div");
    seg.className = "splash-seg";
    segbar.appendChild(seg);
    _splashSegs.push(seg);
  }
  // Shimmer timer ~60fps
  _splashShimmerTimer = setInterval(splashShimmerTick, 16);
}

function splashShimmerTick() {
  _splashShimmerPos = (_splashShimmerPos + 1) % SPLASH_SEG_COUNT;
  for (let i = 0; i < SPLASH_SEG_COUNT; i++) {
    if (!_splashSegs[i]) continue;
    if (i < _splashLastSegCount) {
      _splashSegs[i].className = i === _splashShimmerPos ? "splash-seg splash-seg-bright" : "splash-seg splash-seg-active";
    } else {
      _splashSegs[i].className = "splash-seg";
    }
  }
}

function setSplashStatus(msg, progress = 0) {
  const statusEl = document.getElementById("splashStatus");
  const pctEl = document.getElementById("splashPercent");
  if (statusEl) statusEl.textContent = msg.toUpperCase();
  if (pctEl) {
    const pct = Math.min(100, Math.round(progress * 100));
    pctEl.textContent = pct + "%";
  }
  const segCount = Math.min(SPLASH_SEG_COUNT, Math.round(progress * SPLASH_SEG_COUNT));
  _splashLastSegCount = segCount;
}

async function runSplashSequence() {
  initSplash();
  await sleep(300);

  const DURATION = 3000; // 3 detik — single splash, no HUD overlay
  const startTime = performance.now();

  const stages = [
    { at: 0,   text: "MENYIAPKAN" },
    { at: 5,   text: "Inisialisasi aplikasi..." },
    { at: 15,  text: "Memuat mesin ML..." },
    { at: 35,  text: "Memeriksa progress tersimpan..." },
    { at: 55,  text: "Memuat antarmuka..." },
    { at: 75,  text: "Menyiapkan komponen UI..." },
    { at: 90,  text: "Memverifikasi komponen..." },
    { at: 98,  text: "Selesai" },
  ];

  function tick() {
    const elapsed = performance.now() - startTime;
    const progress = Math.min(1.0, elapsed / DURATION);
    const pct = Math.floor(progress * 100);

    // Update status text sesuai threshold
    for (let i = stages.length - 1; i >= 0; i--) {
      if (pct >= stages[i].at) {
        setSplashStatus(stages[i].text, progress);
        break;
      }
    }

    if (progress < 1.0) {
      requestAnimationFrame(tick);
    } else {
      setSplashStatus("Selesai", 1.0);
      setTimeout(closeSplash, 400);
    }
  }

  requestAnimationFrame(tick);
  await sleep(DURATION + 500);
}

function closeSplash() {
  if (_splashShimmerTimer) {
    clearInterval(_splashShimmerTimer);
    _splashShimmerTimer = null;
  }
  const splash = document.getElementById("splashScreen");
  if (!splash) return;
  splash.classList.add("splash-hiding");
  setTimeout(() => {
    splash.remove();
  }, 250);
}

function sleep(ms) {
  return new Promise(r => setTimeout(r, ms));
}

// ═══════════════════════════════════════════════════════
// INIT
// ═══════════════════════════════════════════════════════
document.addEventListener("DOMContentLoaded", () => {
  runSplashSequence();
  initApp();
});

async function initApp() {
  loadSettings();
  applyTheme(settings.theme);
  ml = await AwbMlEngine.loadWithSeed();
  log("Siap. Kurir: " + COURIER, "info");
  log(`Mesin ML dimuat: ${ml.history.length} data | ${Object.keys(ml.cityKdes).length} kota KDE | batas AREA=${ml.getAreaCeiling()}`, "system");
  populateKotaAutocomplete();
  checkProgressOnStartup();

  // ── Keep-alive: prevent Vercel cold start ──
  // Ping API setiap 5 menit supaya function tetap warm
  setInterval(async () => {
    try {
      await fetch("/api/track?awb=keepalive&courier=sicepat&provider=biteship", {
        method: "HEAD",
        signal: AbortSignal.timeout(5000)
      });
    } catch {}
  }, 5 * 60 * 1000); // 5 menit

  // ── Auto-update check: poll HTML for new build ID ──
  let currentBuildId = null;
  const initBuildId = (document.querySelector('script[src*="app.js"]')?.src.match(/app\.js\?v=([^&"]+)/)?.[1]) ||
                      (document.querySelector('link[href*="style.css"]')?.href.match(/style\.css\?v=([^&"]+)/)?.[1]);
  if (initBuildId) currentBuildId = initBuildId;

  async function checkForUpdate() {
    try {
      const resp = await fetch("/?_t=" + Date.now(), { cache: "no-store", signal: AbortSignal.timeout(5000) });
      const html = await resp.text();
      const match = html.match(/app\.js\?v=([^&"']+)/) || html.match(/style\.css\?v=([^&"']+)/);
      const newBuildId = match?.[1];
      if (newBuildId && newBuildId !== currentBuildId) {
        showUpdateToast(newBuildId);
        return true;
      }
    } catch {}
    return false;
  }

  function showUpdateToast(buildId) {
    if (document.querySelector(".update-toast")) return;
    const toast = document.createElement("div");
    toast.className = "update-toast";
    toast.innerHTML = `
      <span>Versi baru tersedia</span>
      <button class="toast-reload">Refresh Sekarang</button>
      <button class="toast-dismiss">Nanti</button>
    `;
    toast.querySelector(".toast-reload").onclick = () => {
      localStorage.setItem("awb_pending_reload", "1");
      location.reload();
    };
    toast.querySelector(".toast-dismiss").onclick = () => toast.remove();
    document.body.appendChild(toast);
    // Auto-refresh kalau user idle > 5 menit
    let idleTimer = setTimeout(() => {
      localStorage.setItem("awb_pending_reload", "1");
      location.reload();
    }, 5 * 60 * 1000);
    toast.addEventListener("mouseenter", () => clearTimeout(idleTimer));
  }

  // Check setiap 2 menit
  setInterval(checkForUpdate, 2 * 60 * 1000);
  // Check juga saat window fokus kembali
  window.addEventListener("focus", checkForUpdate);

  // Wire up UI
  document.getElementById("btnTrack").onclick = btnTrackClick;
  document.getElementById("btnTrackSearch").onclick = btnTrackSearchClick;
  document.getElementById("btnPause").onclick = btnPauseClick;
  document.getElementById("btnReset").onclick = btnResetClick;
  document.getElementById("btnStop").onclick = btnStopClick;
  document.getElementById("btnNext").onclick = btnNextClick;
  document.getElementById("btnExport").onclick = btnExportClick;
  document.getElementById("btnSettings").onclick = openSettings;
  document.getElementById("btnSettingsSave").onclick = saveSettingsClick;
  document.getElementById("btnSettingsCancel").onclick = closeSettings;
  document.getElementById("btnExportModel").onclick = btnExportModelClick;
  document.getElementById("chkHideAwbColumn").onchange = chkHideAwbChange;
  document.getElementById("chkSortByTime").onchange = chkSortByTimeChange;
  document.getElementById("chkNewPrintOnly").onchange = chkNewPrintOnlyChange;
  document.getElementById("chkRealtimeAggr").onchange = chkRealtimeAggrChange;
  document.querySelectorAll(".carrier-option").forEach((button) => {
    button.addEventListener("click", () => setCarrierMode(button.dataset.carrier));
  });
  document.getElementById("spxCandidatesFile").addEventListener("change", loadSpxCandidates);
  document.getElementById("spxTrackingFiles").addEventListener("change", loadSpxTracking);

  // Theme selector buttons
  document.querySelectorAll("#themeSelector .seg-btn").forEach(btn => {
    btn.addEventListener("click", () => {
      document.querySelectorAll("#themeSelector .seg-btn").forEach(b => b.classList.remove("active"));
      btn.classList.add("active");
    });
  });

  // Speed selector buttons
  document.querySelectorAll("#speedSelector .seg-btn").forEach(btn => {
    btn.addEventListener("click", () => {
      document.querySelectorAll("#speedSelector .seg-btn").forEach(b => b.classList.remove("active"));
      btn.classList.add("active");
    });
  });

  // Global Keyboard Shortcuts
  document.addEventListener("keydown", (e) => {
    // Escape (Esc) untuk Stop
    if (e.key === "Escape") {
      const btnStop = document.getElementById("btnStop");
      if (btnStop && !btnStop.parentElement.classList.contains("hidden")) {
        e.preventDefault();
        btnStop.click();
        return;
      }
    }

    // Space (Spasi) untuk Pause / Resume
    if (e.key === " ") {
      // Pastikan bukan lagi ngetik di input text/textarea biar nggak kepause pas ngetik spasi
      const activeEl = document.activeElement;
      if (activeEl.tagName !== "INPUT" && activeEl.tagName !== "TEXTAREA") {
        const btnPause = document.getElementById("btnPause");
        if (btnPause && !btnPause.classList.contains("hidden")) {
          e.preventDefault();
          btnPause.click();
          return;
        }
      }
    }

    // 1. Enter untuk Next (kalau tombol Next lagi muncul)
    const btnNext = document.getElementById("btnNext");
    if (e.key === "Enter" && btnNext && !btnNext.parentElement.classList.contains("hidden")) {
      e.preventDefault();
      btnNextClick();
      return;
    }

    // 2. Enter untuk Lacak (Pencarian / Brute Force)
    if (e.key === "Enter" && !e.shiftKey) {
      const activeEl = document.activeElement;
      if (!activeEl) return;
      
      // Jika lagi ngetik di Opsi 1 (AWB Tunggal/Batch)
      if (activeEl.id === "txtAwb") {
        e.preventDefault();
        btnTrackClick();
      }
      // Jika lagi ngetik di form Opsi 2 (Jam / Tanggal / Kota)
      else if (activeEl.id === "txtJam" || activeEl.id === "txtTanggal" || activeEl.id === "txtKota") {
        e.preventDefault();
        btnTrackSearchClick();
      }
    }
  });



  // Log controls
  document.getElementById("btnClearLog").onclick = clearLog;
  document.getElementById("btnMinimalLog").onclick = toggleMinimalLog;

  // Music Player init
  initMusicPlayer();

  // Restore UI preferences
  document.getElementById("chkHideAwbColumn").checked = settings.hideAwbColumn;
  document.getElementById("chkSortByTime").checked = settings.sortByTime;
  document.getElementById("chkNewPrintOnly").checked = settings.newPrintOnly;
  document.getElementById("chkRealtimeAggr").checked = settings.realtimeAggr;

  // Log: flush via requestAnimationFrame (no batching delay)
  logRafId = requestAnimationFrame(flushLogQueue);
}

// ═══════════════════════════════════════════════════════
// API CALL — Vercel proxy keeps provider credentials server-side
// ═══════════════════════════════════════════════════════

// Keep provider credentials on the server; the browser only calls our Vercel function.
async function trackAwbProxy(awb, courier, provider = "biteship", signal = null) {
  const query = new URLSearchParams({ awb, courier, provider });
  const resp = await fetch(`/api/track?${query}`, {
    signal: signal || AbortSignal.timeout(30000),
  });
  if (resp.status === 404) return null;
  const body = await resp.json();
  if (!resp.ok) throw new Error(body.error || `Tracking API returned HTTP ${resp.status}`);
  return body;
}

// ── Rate limiter (DEPRECATED — kept for batch track mode) ──
async function rateAcquire() {
  while (_rateTokens < 1) {
    await new Promise(r => setTimeout(r, 100));
    _rateTokens = Math.min(10, _rateTokens + 1);
  }
  _rateTokens--;
}

// ── Main track function ──
// Returns raw Biteship JSON (or null) — backward compatible
async function trackAwb(awb, courier = COURIER, signal = null) {
  return trackAwbProxy(awb, courier, "biteship", signal);
}

// ── Track MID for retry — returns {code, result} untuk realtime retry logic ──
async function trackMidForRetry(awb, courier = COURIER) {
  try {
    const result = await trackAwbProxy(awb, courier, "biteship");
    return { code: result ? "found" : "not_found", result };
  } catch (error) {
    return { code: "error", result: null, error };
  }
}

function setCarrierMode(courier) {
  if (courier !== "sicepat" && courier !== "spx") return;
  if (cts && !cts.cancelled) {
    log("Hentikan proses aktif sebelum mengganti kurir.", "warning");
    return;
  }

  COURIER = courier;
  const isSpx = courier === "spx";
  document.querySelectorAll(".carrier-option").forEach((button) => {
    button.classList.toggle("active", button.dataset.carrier === courier);
  });
  document.getElementById("specificSearchGroup").classList.remove("hidden");
  document.getElementById("spxDataGroup").classList.toggle("hidden", !isSpx);
  document.getElementById("btnTrackSearch").classList.remove("hidden");
  document.getElementById("appTitle").textContent = isSpx ? "AWB Tracker · SPX" : "SiCepat Jinxpro";
  document.getElementById("txtTanggal").placeholder = isSpx ? "2026-11-20 atau 2026-11" : "2026-07-11";
  document.getElementById("txtAwb").placeholder = isSpx
    ? "Tempel satu atau beberapa nomor resi SPX"
    : "004612348765\n004612348766";
  log(`Kurir aktif: ${isSpx ? "SPX (pencarian tanggal/jam dari kandidat)" : "SiCepat"}.`, "system");
}

async function loadSpxCandidates(event) {
  const file = event.target.files[0];
  if (!file) return;
  try {
    spxCandidates = parseSpxCandidates(await file.text());
    document.getElementById("spxCandidatesInfo").textContent =
      `${file.name} · ${spxCandidates.size.toLocaleString("id-ID")} resi`;
    log(`Data kandidat SPX dimuat: ${spxCandidates.size} resi.`, "success");
  } catch (error) {
    spxCandidates = new Map();
    document.getElementById("spxCandidatesInfo").textContent = "Gagal memuat data kandidat.";
    log(`Data kandidat SPX gagal dimuat: ${error.message}`, "error");
  }
}

async function loadSpxTracking(event) {
  const files = [...event.target.files];
  if (files.length === 0) return;
  try {
    const sources = await Promise.all(files.map(async (file) => parseSpxTracking(await file.text())));
    const combined = new Map();
    for (const source of sources) {
      for (const [resi, entry] of source) {
        const previous = combined.get(resi);
        if (!previous || entry.latest_checkpoint_date >= previous.latest_checkpoint_date) {
          combined.set(resi, entry);
        }
      }
    }
    spxTracking = combined;
    document.getElementById("spxTrackingInfo").textContent =
      `${files.length} file · ${spxTracking.size.toLocaleString("id-ID")} status`;
    log(`Data tracking SPX dimuat: ${spxTracking.size} resi dari ${files.length} file.`, "success");
  } catch (error) {
    spxTracking = new Map();
    document.getElementById("spxTrackingInfo").textContent = "Gagal memuat data tracking.";
    log(`Data tracking SPX gagal dimuat: ${error.message}`, "error");
  }
}

async function trackSpxBatch(awbList) {
  const button = document.getElementById("btnTrack");
  button.disabled = true;
  results = [];
  startTime = Date.now();
  log(`Melacak ${awbList.length} resi melalui SPX...`, "system");

  for (const awb of awbList) {
    let liveEntry = null;
    try {
      const response = await fetch(`/api/spx-track?awb=${encodeURIComponent(awb)}`, {
        signal: AbortSignal.timeout(15000),
      });
      const payload = await response.json();
      if (response.ok && payload?.ok) liveEntry = payload.result;
    } catch (error) {
      log(`SPX live tidak tersedia untuk ${awb}: ${error.message}`, "warning");
    }

    if (liveEntry) {
      const liveTracking = new Map([[normalizeResi(awb), liveEntry]]);
      const mergedTracking = new Map([...spxTracking, ...liveTracking]);
      results.push(buildSpxResult(awb, spxCandidates, mergedTracking));
    } else {
      results.push(buildSpxResult(awb, spxCandidates, spxTracking));
    }
    const result = results[results.length - 1];
    if (result.status !== "Tidak ditemukan" && result.status !== "Belum ada status") {
      log(`✓ ${awb} — ${result.status}`, "success");
    }
  }

  renderResultsNow();
  updateStats(new Date(Date.now() - startTime), awbList.length);
  button.disabled = false;
  log(`Pelacakan SPX selesai: ${results.length} resi.`, "success");
}

async function trackSpxSearch(targetDate, jam, timeRange, kota) {
  const candidates = filterSpxCandidates(spxCandidates, targetDate, timeRange);
  if (candidates.length === 0) {
    log(`Tidak ada kandidat SPX pada ${targetDate}${jam ? ` jam ${jam}` : ""}. Periksa rentang tanggal/jam atau file kandidat.`, "warning");
    return;
  }

  setButtonsDisabled(true);
  document.getElementById("btnStop").classList.remove("hidden");
  document.getElementById("btnPause").classList.add("hidden");
  const controller = new AbortController();
  cts = {
    cancelled: false,
    signal: controller.signal,
    abort() {
      this.cancelled = true;
      controller.abort();
    },
  };
  results = [];
  startTime = Date.now();
  log(`=== PENCARIAN SPX: TANGGAL/BULAN + JAM ===`, "system");
  log(`Target=${targetDate} | Jam=${jam || "semua"} | Kandidat=${candidates.length}${kota ? ` | Kota=${kota}` : ""}`, "info");

  let nextIndex = 0;
  let checked = 0;
  let errors = 0;
  const worker = async () => {
    while (!cts.cancelled) {
      const index = nextIndex++;
      if (index >= candidates.length) return;
      const candidate = candidates[index];
      const candidateNumber = normalizeResi(candidate.resi);
      const awb = candidateNumber.startsWith("SPXID")
        ? candidateNumber
        : `SPXID${candidateNumber.replace(/B$/, "")}B`;
      try {
        const response = await fetch(`/api/spx-track?awb=${encodeURIComponent(awb)}`, {
          signal: cts.signal,
        });
        const payload = await response.json();
        checked++;
        const entry = response.ok && payload?.ok
          ? payload.result
          : spxTracking.get(normalizeResi(awb)) ||
            spxTracking.get(candidateNumber) || {
              resi: awb,
              waybill_id: awb,
              latest_status: "Belum ada status live",
              latest_checkpoint_date: candidate.date,
              latest_note: "Waktu dari data kandidat SPX",
              records: [],
            };
        if (entry) {
          const matchedEvent = (entry.records || []).find((record) => {
            const timestamp = record.actual_time
              ? parseSpxDate(record.actual_time)
              : new Date(Number(record.timestamp) * 1000);
            if (Number.isNaN(timestamp.getTime())) return false;
            const eventDateTime = formatSpxDateTime(timestamp);
            const eventDate = eventDateTime.date;
            const [eventHour, eventMinute] = eventDateTime.time.split(":").map(Number);
            const eventMinutes = eventHour * 60 + eventMinute;
            const dateMatches = eventDate.startsWith(targetDate);
            const timeMatches = !timeRange || (eventMinutes >= timeRange.start && eventMinutes <= timeRange.end);
            const eventText = record.message || record.description || "";
            const cityMatches = !kota || matchDestination(eventText, kota);
            return dateMatches && timeMatches && cityMatches;
          }) || (!kota || matchDestination(entry.latest_note || "", kota) ? {
            actual_time: parseSpxDate(candidate.date).toISOString(),
            status: entry.latest_status || "Belum ada status live",
            message: entry.latest_note || "Waktu dari data kandidat SPX",
          } : null);

          if (matchedEvent) {
            const tracking = new Map([[normalizeResi(awb), entry]]);
            const result = buildSpxResult(awb, spxCandidates, tracking);
            const matchedDate = parseSpxDate(matchedEvent.actual_time || Number(matchedEvent.timestamp) * 1000);
            const matchedDateTime = formatSpxDateTime(matchedDate);
            result.tanggal = matchedDateTime.date;
            result.jam = matchedDateTime.time;
            result.lastUpdate = `${result.tanggal} ${result.jam}`;
            result.status = matchedEvent.status || result.status;
            result.receiver = matchedEvent.message || result.receiver;
            results.push(result);
            renderResults();
            log(`✓ ${awb} — ${result.tanggal} ${result.jam} — ${result.status}`, "success");
          }
        }
        if (!response.ok && response.status !== 404) {
          errors++;
          if (errors <= 5) log(`Gagal cek ${awb}: ${payload?.error || `HTTP ${response.status}`}`, "warning");
        }
      } catch (error) {
        if (cts.cancelled) return;
        errors++;
        if (errors <= 5) log(`Gagal cek ${awb}: ${error.message}`, "warning");
        if (!kota) {
          const entry = spxTracking.get(normalizeResi(awb)) ||
            spxTracking.get(candidateNumber) || {
              resi: awb,
              waybill_id: awb,
              latest_status: "Belum ada status live",
              latest_checkpoint_date: candidate.date,
              latest_note: "Waktu dari data kandidat SPX",
              records: [],
            };
          const result = buildSpxResult(awb, spxCandidates, new Map([[normalizeResi(awb), entry]]));
          const candidateDateTime = formatSpxDateTime(parseSpxDate(candidate.date));
          result.tanggal = candidateDateTime.date;
          result.jam = candidateDateTime.time;
          result.lastUpdate = `${result.tanggal} ${result.jam}`;
          results.push(result);
          renderResults();
        }
      }

      if (checked > 0 && checked % 25 === 0) {
        log(`SPX dipindai ${checked}/${candidates.length} | cocok=${results.length} | gagal=${errors}`, "info");
        updateStats(new Date(Date.now() - startTime), checked);
      }
    }
  };

  try {
    await Promise.all(Array.from({ length: Math.min(4, candidates.length) }, worker));
    renderResultsNow();
    updateStats(new Date(Date.now() - startTime), checked);
    log(cts.cancelled
      ? `Pencarian SPX dihentikan. Dipindai ${checked}, cocok ${results.length}.`
      : `Pencarian SPX selesai. Dipindai ${checked}, cocok ${results.length}.`, cts.cancelled ? "warning" : "success");
  } finally {
    cts = null;
    setButtonsDisabled(false);
    document.getElementById("btnStop").classList.add("hidden");
  }
}

function parseSpxDate(value) {
  if (typeof value === "number") return new Date(value * 1000);
  const date = String(value ?? "");
  const hasTimezone = /(?:Z|[+-]\d{2}:?\d{2})$/i.test(date);
  return new Date(!hasTimezone && /^\d{4}-\d{2}-\d{2}T/.test(date) ? `${date}+07:00` : date);
}

function formatSpxDateTime(date) {
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

// ═══════════════════════════════════════════════════════
// MODE 1: BATCH TRACKING (BtnTrack)
// ═══════════════════════════════════════════════════════
async function btnTrackClick() {
  const raw = document.getElementById("txtAwb").value.trim();
  if (!raw) return;

  const awbList = [...new Set(
    raw.split("\n").map(s => s.trim()).filter(s => s.length > 0)
  )];
  if (awbList.length === 0) return;

  if (COURIER === "spx") {
    trackSpxBatch(awbList);
    return;
  }

  document.getElementById("btnTrack").disabled = true;
  cts = { cancelled: false };
  results = [];
  startTime = Date.now();

  log(`Melacak ${awbList.length} nomor resi...`, "system");

  const semaphore = { current: 0, max: 5 };
  let done = 0;

  const tasks = awbList.map(async (awb) => {
    await acquireSemaphore(semaphore);
    try {
      const current = ++done;
      log(`[${current}/${awbList.length}] Melacak ${awb}...`, "info");

      const result = await trackAwb(awb);
      const row = createBiteshipRow(awb, result);

      results.push(row);
      renderResults();
      log(`✓ ${awb} — ${row.status}`, "success");
    } catch (err) {
      results.push({ awb, status: "Gagal: " + err.message, receiver: "-", destination: "-", lastUpdate: "-", jam: "-", tanggal: "-" });
      renderResults();
      log(`✗ ${awb} — ${err.message}`, "error");
    } finally {
      releaseSemaphore(semaphore);
    }
  });

  await Promise.all(tasks);

  const duration = new Date(Date.now() - startTime);
  updateStats(duration, awbList.length);

  log(`Selesai! ${results.length} hasil.`, "success");
  document.getElementById("btnTrack").disabled = false;
  cts = null;
}

// ═══════════════════════════════════════════════════════
// MODE 2: SEARCH BY DATE/TIME/CITY (BtnTrackSearch)
// ═══════════════════════════════════════════════════════
async function btnTrackSearchClick() {
  const jam = document.getElementById("txtJam").value.trim();
  const tgl = document.getElementById("txtTanggal").value.trim();
  const kota = document.getElementById("txtKota").value.trim();

  if (COURIER === "spx") {
    const timeRange = parseTimeRange(jam);
    if (!/^\d{4}-\d{2}(?:-\d{2})?$/.test(tgl)) {
      log("Untuk SPX, tanggal wajib format YYYY-MM-DD atau bulan YYYY-MM. Contoh: 2026-11-20 atau 2026-11.", "warning");
      return;
    }
    if (jam && !timeRange) {
      log("Format jam harus HH:mm atau HH:mm-HH:mm. Contoh: 11:00-13:00", "warning");
      return;
    }
    if (spxCandidates.size === 0) {
      log("Pilih file daftar resi valid SPX terlebih dahulu pada DATA SNAPSHOT SPX.", "warning");
      return;
    }
    await trackSpxSearch(tgl, jam, timeRange, kota);
    return;
  }

  if (!tgl || !/^\d{4}-\d{2}-\d{2}$/.test(tgl)) {
    log("Tanggal wajib format YYYY-MM-DD. Contoh: 2026-07-11", "warning");
    return;
  }

  const timeRange = parseTimeRange(jam);
  if (jam && !timeRange) {
    log("Format jam harus HH:mm atau HH:mm-HH:mm. Contoh: 11:00-13:00", "warning");
    return;
  }

  if (kota) {
    log(`Filter kota: ${kota}`, "info");
  }

  setButtonsDisabled(true);
  document.getElementById("btnStop").classList.remove("hidden");
  cts = { cancelled: false, abort() { this.cancelled = true; } };
  const abortController = new AbortController();
  cts.signal = abortController.signal;

  let checkedMids = new Set();
  let checkedAreas = new Set();

  if (!_paused) {
    results = [];
    document.getElementById("icResults").innerHTML = "";
    visitedAwbSuffix = new Set();
  }

  startTime = Date.now();

  const newPrintOnly = document.getElementById("chkNewPrintOnly").checked;
  const realtimeAggr = document.getElementById("chkRealtimeAggr").checked;

  let seedMid = "";
  let skipMidPhase = false;
  if (progress && progress.phase) {
    const targetChanged = progress.targetDate !== tgl || progress.targetKota !== kota ||
      (progress.newPrintOnly || false) !== newPrintOnly;
    if (targetChanged) {
      log("Progress lama beda target/filter \u2014 dihapus agar scan mulai fresh.", "warning");
      deleteProgress();
    }
  }

  if (progress && progress.phase) {
    checkedMids = new Set(progress.checkedMids || []);
    checkedAreas = new Set(progress.checkedAreas || []);
    if (progress.phase === "area" && progress.foundMid) {
      skipMidPhase = true;
      log(`Lanjut: lewati fase MID, langsung AREA (MID=${progress.foundMid})`, "system");
    } else {
      log(`Lanjut MID: lewati ${checkedMids.size} MID sudah dipindai`, "system");
    }
  } else {
    progress = { phase: "mid", targetDate: tgl, targetKota: kota, newPrintOnly };
    saveProgress();
  }

  log("=== MODE PENCARIAN: JAM/TANGGAL/KOTA ===\n", "system");
  log(`Tanggal=${tgl} | Jam=${jam || "semua"} | Tujuan=${kota || "semua (bebas)"}`, "info");
  log("Format tujuan ideal: Kecamatan, Kota. Contoh: Cengkareng, Jakarta Barat", "system");

  const maxConcurrent = Math.round(32 * Math.max(1.0, settings.speedMultiplier));
  const workerDelay = Math.max(10, Math.round(BASE_WORKER_DELAY_MS / settings.speedMultiplier));
  const workerJitter = Math.max(5, Math.round(50 / settings.speedMultiplier));
  log(`Speed: ${settings.speedMultiplier}x \u2192 ${maxConcurrent} workers, delay ${workerDelay}ms`, "system");
  let midScanned = 0, areaScanned = 0, midFailed = 0, areaFailed = 0;
  let validMidAwb = 0, validAreaAwb = 0, foundCounter = 0;

  try {
    let foundMid = skipMidPhase ? progress.foundMid : null;
    let foundMidResponse = null;
    let foundMidAwb = null;

    const midOrder = buildRbMidOrder(tgl, timeRange, kota);
    log(`ML MID: titik pusat=${midOrder[0]} radius=${ml.getAdaptiveRadius()}`, "system");

    const fallbackMax = 32;
    const candidateMids = buildFallbackMids(tgl, kota, timeRange, seedMid, midOrder, fallbackMax);
    if (candidateMids.length > 0) {
      const seen = new Set(candidateMids);
      const mergedOrder = [...candidateMids];
      for (const m of midOrder) {
        if (!seen.has(m)) { seen.add(m); mergedOrder.push(m); }
      }
      midOrder.length = 0;
      midOrder.push(...mergedOrder);
      log(`Kandidat MID dari histori: ${candidateMids.slice(0, 5).join(", ")}... (prioritas di depan spiral)`, "system");
    }

    const now = new Date();
    const todayStr = now.getFullYear() + "-" + String(now.getMonth()+1).padStart(2,"0") + "-" + String(now.getDate()).padStart(2,"0");
    const tomorrow = new Date(now.getTime() + 86400000);
    const tomorrowStr = tomorrow.getFullYear() + "-" + String(tomorrow.getMonth()+1).padStart(2,"0") + "-" + String(tomorrow.getDate()).padStart(2,"0");
    const isRealtime = (tgl === todayStr) || (tgl === tomorrowStr) ||
      (Math.abs(new Date(tgl).getTime() - now.getTime()) < 48 * 3600 * 1000);
    if (isRealtime) {
      const rtMode = realtimeAggr ? "AGGRESSIVE" : "STANDARD";
      const rtNarrow = realtimeAggr ? 2500 : 1500;
      const rtBudget = realtimeAggr ? 35 : 25;
      log(`\ud83d\udfe2 Mode REALTIME ${rtMode} (target=${tgl}, hari ini=${todayStr}) \u2014 narrow ${rtNarrow} + broad scan paralel + retry budget ${rtBudget} menit`, "system");
    }

    log("\ud83d\udd0e Mencari MID...", "system");
    log(`Titik pusat MID (ML): ${midOrder[0]} | prioritas pindai di sekitar titik pusat`, "system");

    const midLock = { found: false };
    const midAbort = new AbortController();
    const noDataMids = [];
    let midValidNoMatch = 0;

    const NARROW_COUNT = realtimeAggr ? 2500 : 1500;
    const narrowMids = midOrder.slice(0, NARROW_COUNT);
    const broadMids = midOrder.slice(NARROW_COUNT);

    async function midWorker(midsList, queueObj) {
      while (!cts.cancelled && !midLock.found && queueObj.idx < midsList.length) {
        const myIdx = queueObj.idx++;
        if (myIdx >= midsList.length) break;

        const midStr = midsList[myIdx];
        if (checkedMids.has(midStr)) continue;
        const awbSuffix = midStr + FIXED_FIELD;
        if (visitedAwbSuffix.has(awbSuffix)) continue;
        const awb = PREFIX + awbSuffix;

        await sleep(workerDelay + Math.random() * workerJitter);
        if (midLock.found || cts.cancelled) break;

        try {
          let rawResult, trackCode;
          if (isRealtime) {
            const tracked = await trackMidForRetry(awb, COURIER);
            rawResult = tracked.result;
            trackCode = tracked.code;
          } else {
            rawResult = await trackAwb(awb, COURIER, midAbort.signal);
            trackCode = rawResult ? "found" : "not_found";
          }

          const current = ++midScanned;
          checkedMids.add(midStr);
          visitedAwbSuffix.add(awbSuffix);
          progress.lastMid = midStr;

          if (trackCode === "not_found") {
            noDataMids.push(midStr);
          }

          if (current % 50 === 0) {
            log(`Mencari MID: dipindai ${current} | valid=${validMidAwb} | no-match=${midValidNoMatch} | no-data=${noDataMids.length} | gagal=${midFailed}`, "info");
            updateStats(null, current);
            if (current % SAVE_EVERY === 0) {
              progress.checkedMids = [...checkedMids];
              saveProgress();
            }
            if (current % 500 === 0) ml.save();
          }

          if (trackCode !== "found") continue;
          if (!isValidBiteshipResult(rawResult)) continue;
          validMidAwb++;

          const date = extractShipmentDate(rawResult);
          const dest = buildDestination(rawResult);
          const dateOk = dateMatches(rawResult, tgl, timeRange);

          if (!dateOk) {
            midValidNoMatch++;
            if ((midValidNoMatch <= 5 || midValidNoMatch % 10 === 0) && matchDestination(dest, kota)) {
              const diag = getBiteshipDiag(rawResult);
              log(`\u26a0\ufe0f  VALID (no-match)   -> ${awb} | ${date} | ${dest} | ${diag}`, "warning");
            }
          }

          const displayDate = dateOk ? extractMatchingDate(rawResult, tgl, timeRange) : date;
          const mark = dateOk ? " \ud83c\udfaf" : "";
          if (date && dest && (dateOk || matchDestination(dest, kota))) {
            log(`Mencari MID: \u2705 VALID${mark}    -> ${awb} | ${displayDate} | ${dest}`, "success");
            ml.recordValidAwb(awb, date, dest, parseInt(midStr), 0);
          }

          if (dateOk && !midLock.found) {
            const newPrintOk = !newPrintOnly || isNewPrintStatus(rawResult);
            if (!newPrintOk) continue;
            midLock.found = true;
            foundMid = midStr;
            foundMidResponse = rawResult;
            foundMidAwb = awb;
            midAbort.abort();
          }
        } catch (err) {
          if (err.name === "AbortError") return;
          midFailed++;
          if (midFailed <= 3) {
            log(`MID ${midStr} gagal: ${err.message}`, "error");
          }
        }
      }
    }

    // PHASE 1A: Narrow scan
    log(`\ud83c\udfaf Narrow scan: ${narrowMids.length} MID prioritas di sekitar ML (~${Math.round(narrowMids.length * workerDelay / 1000 / maxConcurrent * 1.5)}s)`, "system");
    const narrowQueue = { idx: 0 };
    const narrowWorkers = [];
    for (let w = 0; w < maxConcurrent; w++) narrowWorkers.push(midWorker(narrowMids, narrowQueue));
    await Promise.all(narrowWorkers);

    if (!midLock.found && !cts.cancelled) {
      log(`Narrow scan selesai: valid=${validMidAwb}, no-match=${midValidNoMatch}, no-data=${noDataMids.length}, error=${midFailed}`, "info");
      if (midValidNoMatch > 0 && validMidAwb === 0) {
        log(`\u26a0\ufe0f  ${midValidNoMatch} MID valid tapi tanggal gak cocok \u2014 cek apakah format jam/tanggal sudah benar`, "warning");
      }
      if (noDataMids.length === 0 && validMidAwb === 0 && midValidNoMatch === 0) {
        log("\u26a0\ufe0f  Semua MID return 404 \u2014 kemungkinan Biteship API bermasalah atau tidak ada data", "error");
      }
    }

    // PHASE 1B: Realtime AGGRESSIVE = broad scan PARALEL + retry
    if (isRealtime && !midLock.found && !cts.cancelled) {
      const RETRY_BUDGET_MS = realtimeAggr ? 35 * 60 * 1000 : 25 * 60 * 1000;
      const RETRY_DELAYS = realtimeAggr ? [3000, 5000, 10000, 15000, 20000, 25000] : [5000, 10000, 15000, 20000, 25000];
      const MAX_RETRIES_PER_MID = realtimeAggr ? 12 : 8;

      let broadPromise = null;
      if (broadMids.length > 0) {
        log(`\ud83d\udd0d Broad scan PARALEL: ${broadMids.length} MID sisanya (jalan barengan retry)`, "system");
        const broadQueue = { idx: 0 };
        const broadWorkers = [];
        const broadWorkerCount = Math.max(8, Math.round(maxConcurrent * 0.5));
        for (let w = 0; w < broadWorkerCount; w++) broadWorkers.push(midWorker(broadMids, broadQueue));
        broadPromise = Promise.all(broadWorkers).then(() => {
          if (!midLock.found) log(`Broad scan selesai (paralel).`, "info");
        });
      }

      if (noDataMids.length > 0) {
        const retryStart = Date.now();
        const midRetryCount = new Map();
        const NO_PROGRESS_THRESH = 5;
        let noProgressCount = 0;
        let prevNoDataSize = noDataMids.length;
        let retry = 0;

        log(`\ud83d\udd04 Mode REALTIME: retry ${noDataMids.length} MID (progressive delay, budget ${RETRY_BUDGET_MS/60000} menit, max ${MAX_RETRIES_PER_MID}x per MID)`, "system");

        while (!midLock.found && !cts.cancelled) {
          const elapsed = Date.now() - retryStart;
          if (elapsed >= RETRY_BUDGET_MS) {
            log(`\u23f0 Budget retry habis (${Math.round(elapsed/1000)}s).`, "warning");
            break;
          }

          const delayIdx = Math.min(retry, RETRY_DELAYS.length - 1);
          const remaining = RETRY_BUDGET_MS - elapsed;
          const delay = Math.min(RETRY_DELAYS[delayIdx], remaining);
          await sleep(delay);
          if (midLock.found || cts.cancelled) break;

          const currentNoData = noDataMids.filter(m => {
            const c = (midRetryCount.get(m) || 0);
            midRetryCount.set(m, c + 1);
            return c < MAX_RETRIES_PER_MID;
          });
          noDataMids.length = 0;

          if (currentNoData.length === 0) {
            log(`Retry #${retry + 1}: semua MID mencapai max retry atau sudah terindex. Break.`, "info");
            break;
          }

          log(`\ud83d\udd04 Retry #${retry + 1} (delay ${delay/1000}s): ${currentNoData.length}/${prevNoDataSize} MID...`, "system");
          const retryQueue = { idx: 0 };
          const retryWorkers = [];
          const retryWorkerCount = Math.min(maxConcurrent, 16);
          for (let w = 0; w < retryWorkerCount; w++) retryWorkers.push(midWorker(currentNoData, retryQueue));
          await Promise.all(retryWorkers);

          if (midLock.found) {
            log(`\u2705 Retry #${retry + 1} BERHASIL: MID ${foundMid}`, "success");
            break;
          }

          const curSize = noDataMids.length;
          if (validMidAwb + midValidNoMatch > 0) {
            if (curSize >= prevNoDataSize) {
              noProgressCount++;
              if (noProgressCount >= NO_PROGRESS_THRESH) {
                log(`\u26d4 Stagnasi: ${validMidAwb} valid, ${midValidNoMatch} no-match, ${curSize} MID sisa stagnan ${NO_PROGRESS_THRESH}x. Early exit.`, "warning");
                break;
              }
            } else {
              noProgressCount = 0;
            }
          } else {
            if (retry <= 5) {
              log(`Retry #${retry + 1}: masih 0 valid \u2014 Biteship mungkin belum index data jam ini. Sabar...`, "info");
            }
            noProgressCount = 0;
          }
          prevNoDataSize = curSize;

          if (noDataMids.length === 0) {
            log(`Retry #${retry + 1}: semua MID terindex (belum match).${retry < 3 ? " Lanjut..." : ""}`, "info");
            if (retry >= 3) break;
          } else if (retry % 3 === 2 && retry > 0) {
            log(`Retry #${retry + 1}: masih ${noDataMids.length} MID 404 \u2014 ${validMidAwb + midValidNoMatch === 0 ? "API mungkin belum index" : "sisa MID mungkin invalid"}`, "warning");
          }

          retry++;
        }

        if (!midLock.found && !cts.cancelled) {
          const elapsed = Date.now() - retryStart;
          const foundAny = validMidAwb + midValidNoMatch > 0;
          log(`Retry selesai (${Math.round(elapsed/1000)}s, ${retry} iterasi). ${foundAny ? `${validMidAwb} valid, ${midValidNoMatch} no-match` : "BELUM ADA data dari Biteship"}. ${noDataMids.length} MID sisa.`, "warning");
        }
      }

      if (broadPromise && !midLock.found) {
        log(`Menunggu broad scan selesai (max 20s)...`, "info");
        await Promise.race([broadPromise, sleep(20000)]);
      }
    } else if (!midLock.found && !cts.cancelled && broadMids.length > 0) {
      log(`\ud83d\udd0d Broad scan: ${broadMids.length} MID sisanya`, "system");
      const broadQueue = { idx: 0 };
      const broadWorkers = [];
      for (let w = 0; w < maxConcurrent; w++) broadWorkers.push(midWorker(broadMids, broadQueue));
      await Promise.all(broadWorkers);
    }

    log(`MID scan selesai: dipindai=${midScanned} valid=${validMidAwb} no-match=${midValidNoMatch} no-data=${noDataMids.length} error=${midFailed}`, "system");

    // Build MID list for AREA phase
    let midsToScanArea = [];
    if (foundMid) midsToScanArea.push(foundMid);
    for (const m of midOrder) {
      if (m !== foundMid && midsToScanArea.length < fallbackMax) {
        midsToScanArea.push(m);
      }
    }
    if (midsToScanArea.length === 0) {
      log("Tidak ada kandidat MID. Coba perlebar rentang jam.", "error");
      deleteProgress();
      progress = null;
      return;
    }
    log(`Mode kandidat AREA: pindai ${midsToScanArea.length} kandidat MID${foundMid ? ` (lanjut dari progress MID=${foundMid})` : ""}`, "warning");

    let matchedResult = null, matchedAwb = null;

    // PHASE 2: AREA scanning — PARALLEL multi-MID
    // Scan up to 4 MIDs concurrently, sharing area order from KDE.
    // Each MID gets the same area ordering but different AWB prefix.
    const PARALLEL_MID_BATCH = Math.min(4, midsToScanArea.length);

    for (let batchStart = 0; batchStart < midsToScanArea.length && !cts.cancelled; batchStart += PARALLEL_MID_BATCH) {
      const midBatch = midsToScanArea.slice(batchStart, batchStart + PARALLEL_MID_BATCH);

      // Dest cache check for each MID in batch (quick)
      let cacheHit = false;
      for (const midCandidate of midBatch) {
        if (cts.cancelled) break;
        const cityKeyForCache = extractCityKey(kota);
        const cacheOut = {};
        if (ml.tryDestCache(cityKeyForCache, cacheOut)) {
          const cacheAwb = PREFIX + midCandidate + String(cacheOut.area).padStart(4, "0");
          log(`CACHE TUJUAN: ${cityKeyForCache} → AREA ${String(cacheOut.area).padStart(4, "0")} | uji ${cacheAwb}`, "system");
          const cacheResult = await trackAwb(cacheAwb);
          if (isValidBiteshipResult(cacheResult) && matchDestination(buildDestination(cacheResult), kota) &&
              dateMatches(cacheResult, tgl, timeRange) && (!newPrintOnly || isNewPrintStatus(cacheResult))) {
            ml.recordValidAwb(cacheAwb, extractShipmentDate(cacheResult), buildDestination(cacheResult), parseInt(midCandidate), cacheOut.area);
            results.push(createBiteshipRow(cacheAwb, cacheResult, tgl, timeRange));
            renderResults();
            updateStats(null, areaScanned);
            matchedAwb = cacheAwb;
            matchedResult = cacheResult;
            foundCounter++;
            log(`HASIL LANGSUNG DARI CACHE: ${cacheAwb}`, "success");
            cacheHit = true;
            showNextButton();
            await waitForNext();
            hideNextButton();
            break;
          }
        }
      }
      if (cacheHit) {
        if (cts.cancelled) break;
        continue;
      }

      progress.phase = "area";
      progress.foundMid = midBatch[0];
      progress.checkedMids = [...checkedMids];
      progress.checkedAreas = [...checkedAreas];
      saveProgress();

      log(`🔎 AREA batch: MID [${midBatch.join(", ")}] — ${midBatch.length} MID paralel`, "system");

      const areaOrder = buildRbAreaOrder(kota);
      const ceiling = ml.getAreaCeiling(extractCityKey(kota));
      log(`Pindai AREA: urutan KDE panduan ML (batas ${ceiling}, ${extractCityKey(kota)})`, "system");

      const foundAreaLock = { found: false };
      let areaQueueIdx = 0;
      const areaItems = areaOrder;

      async function areaWorkerMultiMid(workerId, midCandidate) {
        while (!cts.cancelled && areaQueueIdx < areaItems.length) {
          if (foundAreaLock.found) {
            await sleep(500);
            continue;
          }

          const myIdx = areaQueueIdx++;
          if (myIdx >= areaItems.length) break;

          const areaStr = areaItems[myIdx];
          const awbSuffix = midCandidate + areaStr;
          if (visitedAwbSuffix.has(awbSuffix)) continue;
          const awb = PREFIX + awbSuffix;

          await sleep(workerDelay + Math.random() * workerJitter);
          if (foundAreaLock.found || cts.cancelled) break;

          try {
            const result = await trackAwb(awb, COURIER);
            const current = ++areaScanned;
            visitedAwbSuffix.add(awbSuffix);
            progress.lastArea = areaStr;

            if (current % 50 === 0) {
              log(`Mencari AREA: dipindai ${current} | mid=${midCandidate} | valid=${validAreaAwb} | gagal=${areaFailed} | cocok=${foundCounter}`, "info");
              updateStats(null, current);
              if (current % SAVE_EVERY === 0) {
                saveProgress();
              }
            }

            if (!isValidBiteshipResult(result)) continue;
            validAreaAwb++;

            const date = extractShipmentDate(result);
            const dest = buildDestination(result);
            const destOk = matchDestination(dest, kota);
            const dateOk = dateMatches(result, tgl, timeRange);
            const newPrintOk = !newPrintOnly || isNewPrintStatus(result);
            const matchOk = destOk && dateOk && newPrintOk;
            const displayDate = dateOk ? extractMatchingDate(result, tgl, timeRange) : date;

            if (date && dest) {
              ml.recordValidAwb(awb, date, dest, parseInt(midCandidate), parseInt(areaStr));
            }

            if (date && dest && (matchOk || destOk)) {
              const mark = matchOk ? " 🎯" : (destOk ? " 📅" : "");
              log(`Mencari AREA: ✅ VALID${mark}    -> ${awb} | ${displayDate} | ${dest}`, "success");
            }

            if (!matchOk) continue;
            foundCounter++;

            matchedAwb = awb;
            matchedResult = result;
            results.push(createBiteshipRow(awb, result, tgl, timeRange));

            renderResultsNow();
            updateStats(null, areaScanned);

            if (!foundAreaLock.found) {
              foundAreaLock.found = true;
              showNextButton();
              log("🎉 Match ditemukan! Klik ⏭ Next untuk lanjut.", "success");
              await waitForNext();
              hideNextButton();
              foundAreaLock.found = false;
            }
          } catch (err) {
            if (err.name === 'AbortError') return;
            areaFailed++;
            log(`AREA ${awb} gagal: ${err.message}`, "error");
          }
        }
      }

      // Launch workers: distribute maxConcurrent across all MIDs in batch
      const workersPerMid = Math.max(4, Math.floor(maxConcurrent / midBatch.length));
      const areaWorkers = [];
      for (const midCandidate of midBatch) {
        for (let w = 0; w < workersPerMid; w++) {
          areaWorkers.push(areaWorkerMultiMid(areaWorkers.length, midCandidate));
        }
      }
      await Promise.all(areaWorkers);

      foundAreaLock.found = false;

      if (foundCounter === 0)
        log(`MID ${foundMid} selesai: belum match (scan=${areaScanned} gagal=${areaFailed}), lanjut kandidat berikutnya jika ada.`, "warning");
    }

    // PHASE 3: Extended MID scan
    if (foundCounter === 0 && !cts.cancelled && !_paused) {
      const scannedMidSet = new Set(midsToScanArea.map(m => String(m)));
      const remainingMids = midOrder.filter(m => !scannedMidSet.has(m));
      const EXTENDED_MAX = 200;

      if (remainingMids.length > 0) {
        log(`\ud83d\udd0d Phase 3: scan ${Math.min(remainingMids.length, EXTENDED_MAX)} MID tambahan (dari ${midOrder.length} total) \u2014 nyari yg cocok jam ${jam || "semua"}`, "system");
        const extendedQueue = { idx: 0 };
        const targetList = remainingMids.slice(0, EXTENDED_MAX);

        async function extendedWorker() {
          while (!cts.cancelled && !_paused && extendedQueue.idx < targetList.length) {
            const myIdx = extendedQueue.idx++;
            if (myIdx >= targetList.length) break;
            const midStr = targetList[myIdx];
            if (checkedMids.has(midStr)) continue;
            const awbSuffix = midStr + FIXED_FIELD;
            if (visitedAwbSuffix.has(awbSuffix)) continue;
            const awb = PREFIX + awbSuffix;

            await sleep(workerDelay + Math.random() * workerJitter);
            if (cts.cancelled) break;

            try {
              const result = await trackAwb(awb, COURIER);
              if (!isValidBiteshipResult(result)) continue;

              const dest = buildDestination(result);
              const destOk = matchDestination(dest, kota);
              const dateOk = dateMatches(result, tgl, timeRange);
              const newPrintOk = !newPrintOnly || isNewPrintStatus(result);
              const matchOk = destOk && dateOk && newPrintOk;

              if (dateOk && dest) {
                ml.recordValidAwb(awb, extractShipmentDate(result), dest, parseInt(midStr), 0);
              }

              if (matchOk) {
                ml.recordValidAwb(awb, extractShipmentDate(result), dest, parseInt(midStr), 0);
                results.push(createBiteshipRow(awb, result, tgl, timeRange));
                renderResultsNow();
                updateStats(null, ++areaScanned);
                foundCounter++;
                log(`\ud83c\udfaf Phase 3 MATCH: ${awb} | ${extractShipmentDate(result)} | ${dest}`, "success");
                showNextButton();
                await waitForNext();
                hideNextButton();
              } else if (destOk) {
                log(`Phase 3 VALID (no-time): ${awb} | ${extractShipmentDate(result)} | ${dest}`, "info");
              }
            } catch (err) {
              // skip error
            }
          }
        }

        const extWorkers = [];
        const extCount = Math.min(maxConcurrent, 8);
        for (let w = 0; w < extCount; w++) extWorkers.push(extendedWorker());
        await Promise.all(extWorkers);

        if (foundCounter > 0) {
          log(`\u2705 Phase 3 berhasil: ${foundCounter} match ditemukan dari scan MID tambahan`, "success");
        } else {
          log(`Phase 3 selesai: ${Math.min(remainingMids.length, EXTENDED_MAX)} MID tambahan, 0 match.`, "warning");
        }
      }
    }

    // Final stats
    const duration = new Date(Date.now() - startTime);
    updateStats(duration, midScanned + areaScanned);
    renderResultsNow();

    log("=== PENCARIAN SELESAI ===", "system");
    log(`MID dipindai: ${midScanned} | MID valid: ${validMidAwb} | AREA dipindai: ${areaScanned} | AREA valid: ${validAreaAwb} | Cocok: ${foundCounter} | Durasi: ${formatDuration(duration)}`,
      foundCounter > 0 ? "success" : "warning");

    if (foundCounter > 0) {
      ml.retrainMidModel();
      ml.save();
      log(`Model ML diperbarui & disimpan. Histori: ${ml.history.length} | Batas AREA baru: ${ml.getAreaCeiling()}`, "success");
      syncModelToApi(); // auto-sync ke API
    }

    if (!_paused) {
      deleteProgress();
      progress = null;
      log("Progress dihapus (scan selesai).", "system");
    }
  } catch (err) {
    if (cts?.cancelled) {
      if (progress) {
        progress.checkedMids = [...checkedMids];
        progress.checkedAreas = [...checkedAreas];
        saveProgress();
        log("Dihentikan \u2014 progres disimpan. Bisa dilanjutkan nanti.", "warning");
      } else {
        log("Pencarian dibatalkan.", "warning");
      }
    } else {
      log("Error: " + err.message, "error");
    }
  } finally {
    cts = null;
    if (!_paused) {
      setButtonsDisabled(false);
      document.getElementById("btnStop").classList.add("hidden");
      document.getElementById("btnNext").classList.add("hidden");
    } else {
      const btnPause = document.getElementById("btnPause");
      btnPause.innerHTML = "\u25b6 Lanjut";
      btnPause.onclick = btnResumeClick;
    }
  }
}

// ═══════════════════════════════════════════════════════
// MID/AREA ORDER BUILDERS
// ═══════════════════════════════════════════════════════
function buildRbMidOrder(targetDate, timeRange, targetCity = "") {
  const cityKey = extractCityKey(targetCity);

  // Multi-anchor untuk prefix cities (Jakarta: gabung barat/timur/selatan/utara/pusat)
  const regionAnchors = ml.getRegionAnchors(cityKey);
  if (regionAnchors) {
    const radius = ml.getAdaptiveRadius();
    let adjustedRadius = radius;
    // Pastikan radius cukup buat nyampai beberapa region
    adjustedRadius = Math.max(500, Math.min(adjustedRadius, 1000));
    log(`Multi-anchor: ${regionAnchors.length} sub-regions (${regionAnchors.join(", ")}) radius=${adjustedRadius}`, "system");

    // Interleave: step 0 ambil dari semua anchor, step 1 ambil +1/-1 dari semua anchor, dll
    const merged = [];
    const seen = new Set();
    const maxStep = 10000;
    for (let step = 0; step <= adjustedRadius; step++) {
      for (const anchor of regionAnchors) {
        const candidates = step === 0 ? [anchor] : [anchor + step, anchor - step];
        for (const c of candidates) {
          if (c >= 0 && c < maxStep && !seen.has(c)) {
            seen.add(c);
            merged.push(c);
          }
        }
      }
    }
    // Fill remaining linear
    for (let i = 0; i < maxStep && merged.length < maxStep; i++) {
      if (!seen.has(i)) { seen.add(i); merged.push(i); }
    }
    return merged.map(i => String(i).padStart(4, "0"));
  }

  // Normal single-anchor path
  const anchor = ml.predictMidTwoLevel(targetDate, timeRange);
  const radius = ml.getAdaptiveRadius();

  const varianceSamples = ml.varianceModel.dailyRanges
    .filter(v => v.date && v.date.length >= 10 && v.date.substring(0, 10) === targetDate.substring(0, 10));
  let adjustedRadius = radius;
  if (varianceSamples.length === 0) {
    // Realtime tanpa history variance: radius gede biar spiral nyapu lebar.
    // 800 → 2000 biar nyampe area yang jauh dari anchor ML.
    adjustedRadius = Math.max(1000, Math.min(radius, 2000));
    log(`Belum ada data variance untuk tanggal ${targetDate}, pakai radius agresif=${adjustedRadius}`, "system");
  }

  // FIX: Multi-anchor fallback — ML predict bisa meleset kalau cityKey kompleks.
  // Tambah anchor alternatif di awal urutan biar coverage lebih luas.
  // Anchor cadangan: 0 (pusat), 500, 900 — ketutupin area trafficking tinggi.
  const midList = spiralOrder(anchor, adjustedRadius, 10000).map(i => String(i).padStart(4, "0"));
  
  // Prepend multi-anchor fallback (hanya kalau belum ada region anchors)
  if (cityKey) {
    const fallbackAnchors = ["0500", "0900", "0100"]; // area traficking tinggi
    const existing = new Set(midList);
    for (const fa of fallbackAnchors) {
      const num = parseInt(fa);
      // Spiral kecil dari anchor fallback: ±50
      for (let d = -50; d <= 50; d++) {
        const candidate = String(Math.max(0, Math.min(9999, num + d))).padStart(4, "0");
        if (!existing.has(candidate)) {
          existing.add(candidate);
          midList.unshift(candidate);
        }
      }
    }
    log(`Multi-anchor fallback ditambahkan: ${fallbackAnchors.length} anchor ±50 dari ${anchor} (total ${midList.length} MID)`, "system");
  }

  return midList;
}

function buildRbAreaOrder(targetArea) {
  try {
    const ordered = ml.getAreaOrder(targetArea);
    return ordered.map(a => String(a).padStart(4, "0"));
  } catch (err) {
    const ceiling = ml?.getAreaCeiling(extractCityKey(targetArea)) ?? 9999;
    log(`Urutan AREA ML error: ${err.message} — pakai urutan linear 0-${ceiling}`, "warning");
    return Array.from({ length: ceiling + 1 }, (_, i) => String(i).padStart(4, "0"));
  }
}

function buildFallbackMids(targetDate, targetArea, timeRange, seedMid, midOrder, maxCount) {
  const result = [];
  const seen = new Set();
  const addMid = (mid) => {
    if (mid >= 0 && mid <= 9999) {
      const s = String(mid).padStart(4, "0");
      if (!seen.has(s)) { seen.add(s); result.push(s); }
    }
  };

  if (seedMid && /^\d+$/.test(seedMid)) addMid(parseInt(seedMid));

  const targetCity = extractCityKey(targetArea);
  const hasKota = !!targetArea; // kalo kota kosong, skip filter kota
  const targetDt = new Date(targetDate);
  const targetDtOk = !isNaN(targetDt);

  const candidates = ml.history
    .filter(h => h.date && h.destination)
    .map(h => {
      // Hitung score tanggal/jam (time gap)
      const hDate = new Date(h.date.replace(/\./g, ":"));
      let dateScore = 9999.0;
      let timeScore = 9999.0;
      
      if (targetDtOk && !isNaN(hDate)) {
        // Jarak hari (gap hari)
        const targetMidnight = new Date(targetDt.getTime()); targetMidnight.setHours(0,0,0,0);
        const hMidnight = new Date(hDate.getTime()); hMidnight.setHours(0,0,0,0);
        dateScore = Math.abs(hMidnight - targetMidnight) / 86400000;
        
        // Jarak jam (kalo timeRange ada)
        if (timeRange) {
          const targetMidMinutes = (timeRange.start + timeRange.end) / 2;
          const hMinutes = hDate.getHours() * 60 + hDate.getMinutes();
          timeScore = Math.abs(hMinutes - targetMidMinutes); // dalam menit
        } else {
          timeScore = 0; // Kalo gak nyari jam spesifik, timeScore nol
        }
      }
      
      return {
        mid: h.mid,
        destination: h.destination,
        cityOk: hasKota ? (matchDestination(h.destination, targetArea) || normalizeKey(extractCityKey(h.destination)) === targetCity) : true,
        dateScore: dateScore,
        timeScore: timeScore,
        // PENALTY SANGAT BESAR untuk beda hari, supaya sistem tidak mencomot jam yang pas tapi beda bulan/hari
        totalScore: (dateScore * 1000000) + timeScore 
      };
    })
    .filter(x => x.cityOk)
    .sort((a, b) => a.totalScore - b.totalScore) // Paling mirip tanggal & jam-nya, taruh PALING DEPAN
    .slice(0, maxCount * 3);

  for (const c of candidates) addMid(c.mid);

  for (const c of candidates.slice(0, 4)) {
    for (let delta = 1; delta <= 80; delta += 5) addMid(c.mid + delta);
  }

  const anchor = ml.predictMidTwoLevel(targetDate, timeRange);
  addMid(anchor);
  for (const midStr of midOrder.slice(0, Math.max(0, maxCount * 2)))
    if (/^\d+$/.test(midStr)) addMid(parseInt(midStr));

  return result.slice(0, maxCount);
}

// ═══════════════════════════════════════════════════════
// UI ACTIONS
// ═══════════════════════════════════════════════════════
function btnResetClick() {
  if (nextResolver) nextResolver(false);
  if (cts?.abort) {
    cts.abort();
    log("Scan dibatalkan oleh reset.", "warning");
  }
  deleteProgress();
  progress = null;
  results = [];
  visitedAwbSuffix = new Set(); // reset dedup
  document.getElementById("icResults").innerHTML = "";
  document.getElementById("txtAwb").value = "";
  // Pertahankan jam/tgl/kota — jangan clear
  document.getElementById("txtNoResults").classList.remove("hidden");
  document.getElementById("btnNext").classList.add("hidden");
  document.getElementById("btnStop").classList.remove("hidden");
  document.getElementById("btnNext").classList.add("hidden");
  document.getElementById("btnPause").classList.add("hidden");
  document.getElementById("btnScanRow").classList.add("hidden");
  document.getElementById("btnTrackSearch").classList.remove("hidden");
  log("Dashboard direset. Progress dihapus. Menunggu input baru...", "system");
  updateStats(new Date(0));
}

function btnStopClick() {
  if (nextResolver) nextResolver(false);
  if (cts?.abort) {
    log("Stop — membatalkan scan...", "warning");
    cts.abort();
  }
  // Clear results + render empty state
  results = [];
  renderResultsNow();
  updateStats(new Date(0));
}

function btnPauseClick() {
  if (nextResolver) nextResolver(false);
  if (cts?.abort) {
    _paused = true;
    log("⏸ Pause — scan dijeda. Progress disimpan.", "warning");
    cts.abort();
  }
}

function btnResumeClick() {
  // Reset pause button back to Pause
  const btnPause = document.getElementById("btnPause");
  btnPause.innerHTML = "⏸ Pause";
  btnPause.onclick = btnPauseClick;
  // Reset pause state sebelum restart scan
  _paused = false;
  // Restart scan — will pick up saved progress
  btnTrackSearchClick();
}

function btnNextClick() {
  if (nextResolver) nextResolver(true);
}

function btnExportClick() {
  if (results.length === 0) return;

  let sb = '<?xml version="1.0" encoding="UTF-8"?>\n';
  sb += '<?mso-application progid="Excel.Sheet"?>\n';
  sb += '<Workbook xmlns="urn:schemas-microsoft-com:office:spreadsheet"\n';
  sb += '          xmlns:o="urn:schemas-microsoft-com:office:office"\n';
  sb += '          xmlns:x="urn:schemas-microsoft-com:office:excel"\n';
  sb += '          xmlns:ss="urn:schemas-microsoft-com:office:spreadsheet">\n';
  sb += '  <Styles>\n';
  sb += '    <Style ss:ID="Header">\n';
  sb += '      <Font ss:Bold="1"/>\n';
  sb += '      <Interior ss:Color="#00BCD4" ss:Pattern="Solid"/>\n';
  sb += '    </Style>\n';
  sb += '  </Styles>\n';
  sb += '  <Worksheet ss:Name="AWB Export">\n';
  sb += '    <Table>\n';
  sb += '      <Row>\n';
  for (const header of ["AWB", "Status", "Penerima", "Tujuan", "Update Terakhir", "Courier"])
    sb += `        <Cell ss:StyleID="Header"><Data ss:Type="String">${escapeXml(header)}</Data></Cell>\n`;
  sb += '      </Row>\n';
  for (const r of results) {
    sb += '      <Row>\n';
    for (const val of [r.awb, r.status, r.receiver, r.destination, r.lastUpdate, r.courier])
      sb += `        <Cell><Data ss:Type="String">${escapeXml(val || "")}</Data></Cell>\n`;
    sb += '      </Row>\n';
  }
  sb += '    </Table>\n';
  sb += '  </Worksheet>\n';
  sb += '</Workbook>';

  const blob = new Blob([sb], { type: "application/vnd.ms-excel" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = `AWB_Export_${new Date().toISOString().replace(/[-:T]/g, "").substring(0, 15)}.xls`;
  a.click();
  URL.revokeObjectURL(url);
  log("Excel diekspor.", "success");
}

function chkHideAwbChange() {
  const hide = document.getElementById("chkHideAwbColumn").checked;
  settings.hideAwbColumn = hide;
  saveSettings();
  renderResultsNow();
}

function chkSortByTimeChange() {
  settings.sortByTime = document.getElementById("chkSortByTime").checked;
  saveSettings();
  renderResultsNow();
}

function chkNewPrintOnlyChange() {
  settings.newPrintOnly = document.getElementById("chkNewPrintOnly").checked;
  saveSettings();
}

function chkRealtimeAggrChange() {
  settings.realtimeAggr = document.getElementById("chkRealtimeAggr").checked;
  saveSettings();
}


function btnExportModelClick() {
  try {
    const raw = localStorage.getItem("awb_ml_model");
    if (!raw) { log("Tidak ada model di localStorage.", "warning"); return; }
    const blob = new Blob([raw], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = "awb_model_seed.json";
    a.click();
    URL.revokeObjectURL(url);
    log("Model exported.", "success");
  } catch (e) { log("Export gagal: " + e.message, "error"); }
}

async function syncModelToApi() {
  try {
    const raw = localStorage.getItem("awb_ml_model");
    if (!raw) return;
    await fetch("/api/model", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: raw,
      signal: AbortSignal.timeout(10000),
    });
  } catch (e) {
    // silent fail — tidak blocking
  }
}

// ═══════════════════════════════════════════════════════
// SETTINGS
// ═══════════════════════════════════════════════════════
function loadSettings() {
  try {
    const raw = localStorage.getItem("awb_settings");
    if (raw) settings = { ...settings, ...JSON.parse(raw) };
  } catch {}
}

function saveSettings() {
  localStorage.setItem("awb_settings", JSON.stringify(settings));
}

function openSettings() {
  // Update theme buttons active state
  document.querySelectorAll("#themeSelector .seg-btn").forEach(btn => {
    btn.classList.toggle("active", btn.dataset.theme === settings.theme);
  });
  // Update speed buttons active state
  document.querySelectorAll("#speedSelector .seg-btn").forEach(btn => {
    btn.classList.toggle("active", parseInt(btn.dataset.speed) === settings.speedMultiplier);
  });
  document.getElementById("settingsModal").classList.remove("hidden");
}

function closeSettings() {
  document.getElementById("settingsModal").classList.add("hidden");
}

function saveSettingsClick() {
  // Get active theme button
  const activeThemeBtn = document.querySelector("#themeSelector .seg-btn.active");
  settings.theme = activeThemeBtn ? activeThemeBtn.dataset.theme : "JINX";
  // Get active speed button
  const activeBtn = document.querySelector("#speedSelector .seg-btn.active");
  settings.speedMultiplier = activeBtn ? parseInt(activeBtn.dataset.speed) : 2;
  saveSettings();
  applyTheme(settings.theme);
  closeSettings();
  log("Pengaturan disimpan.", "system");
}

function applyTheme(theme) {
  document.body.classList.remove("theme-light", "theme-jinx", "theme-white");
  if (theme === "Light") document.body.classList.add("theme-light");
  else if (theme === "JINX") document.body.classList.add("theme-jinx");
  else if (theme === "White") document.body.classList.add("theme-white");
}

// ═══════════════════════════════════════════════════════
// PROGRESS (save/resume/reset) + Redis backup
// ═══════════════════════════════════════════════════════
function saveProgress() {
  if (!progress) return;
  try { localStorage.setItem("awb_progress", JSON.stringify(progress)); } catch {}
  // Fire-and-forget to Redis
  syncProgressToRedis(progress);
}

function deleteProgress() {
  try { localStorage.removeItem("awb_progress"); } catch {}
  // Delete from Redis too
  syncProgressToRedis(null);
  progress = null; // reset in-memory state
}

async function syncProgressToRedis(data) {
  try {
    const user = getGuestUser();
    const uid = user?.username || "guest";
    const key = `progress:${uid}`;
    const value = data ? JSON.stringify(data) : "";
    await fetch("/api/redis", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(data ? ["SET", key, value] : ["DEL", key]),
    });
  } catch { /* silently ignore Redis errors */ }
}

async function loadProgressFromRedis() {
  try {
    const user = getGuestUser();
    const uid = user?.username || "guest";
    const key = `progress:${uid}`;
    const resp = await fetch("/api/redis", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(["GET", key]),
    });
    if (!resp.ok) return null;
    const json = await resp.json();
    if (!json.result) return null;
    return JSON.parse(json.result);
  } catch { return null; }
}

function loadProgress() {
  try {
    const raw = localStorage.getItem("awb_progress");
    return raw ? JSON.parse(raw) : null;
  } catch { return null; }
}

function checkProgressOnStartup() {
  progress = loadProgress();
  // Fallback: try Redis if localStorage empty
  if (!progress || !progress.phase) {
    loadProgressFromRedis().then(redisProgress => {
      if (redisProgress && redisProgress.phase) {
        progress = redisProgress;
        log("Progress dipulihkan dari Redis.", "system");
        showProgressResumePrompt();
      }
    });
  }
  if (!progress || !progress.phase) { progress = null; return; }
  showProgressResumePrompt();
}

function showProgressResumePrompt() {
  const midCount = progress.checkedMids?.length || 0;
  const areaCount = progress.checkedAreas?.length || 0;
  const resume = confirm(
    `Ditemukan progress scan sebelumnya:\n` +
    `  Phase: ${progress.phase}\n` +
    `  MID checked: ${midCount}\n` +
    `  AREA checked: ${areaCount}\n` +
    `  Found MID: ${progress.foundMid || "-"}\n\n` +
    `Resume scan? (OK=Resume, Cancel=Hapus & mulai baru)`
  );
  if (!resume) {
    deleteProgress();
    progress = null;
    log("Progress dihapus. Mulai dari awal.", "system");
  } else {
    log(`Resume: phase=${progress.phase} | MID=${midCount} | AREA=${areaCount} | foundMid=${progress.foundMid || "-"}`, "system");
  }
}

// ═══════════════════════════════════════════════════════
// UI RENDERING
// ═══════════════════════════════════════════════════════
function renderResults() {
  // Throttle: during active scan, only render every 150ms
  if (renderPending) return;
  renderPending = true;
  renderTimer = setTimeout(() => {
    renderPending = false;
    renderResultsNow();
  }, 150);
}

function renderResultsNow() {
  if (renderTimer) { clearTimeout(renderTimer); renderTimer = null; }
  renderPending = false;
  const container = document.getElementById("icResults");
  const noResults = document.getElementById("txtNoResults");
  container.innerHTML = "";

  if (results.length === 0) {
    noResults.classList.remove("hidden");
    return;
  }
  noResults.classList.add("hidden");

  let displayResults = results;
  if (settings.sortByTime) {
    // Salin array agar tidak mengubah urutan asli di background
    displayResults = [...results].sort((a, b) => {
      // Parse jam format "HH:MM", fallback ke angka gede banget kalau ga valid
      const parseMinutes = (jamStr) => {
        if (!jamStr) return 99999;
        const m = jamStr.match(/(\d{2}):(\d{2})/);
        if (!m) return 99999;
        return parseInt(m[1]) * 60 + parseInt(m[2]);
      };
      
      const timeA = parseMinutes(a.jam);
      const timeB = parseMinutes(b.jam);
      
      // Jika jam sama, urutkan tanggal sebagai secondary
      if (timeA === timeB) {
        return (a.tanggal || "").localeCompare(b.tanggal || "");
      }
      return timeA - timeB;
    });
  }

  const frag = document.createDocumentFragment();
  const hideAwb = settings.hideAwbColumn;
  for (const item of displayResults) {
    const card = createResultCard(item, hideAwb);
    frag.appendChild(card);
  }
  container.appendChild(frag);
}

function createResultCard(item, hideAwb) {
  const card = document.createElement("div");
  card.className = "result-card";
  const isCopied = copiedAwbs.has(item.awb);

  const awbDisplay = hideAwb ? "****" : item.awb;

  // Map status text to CSS color class
  const statusLower = (item.status || "").toLowerCase();
  let statusClass = "";
  if (statusLower.includes("dikonfirmasi") || (statusLower.includes("pesanan") && statusLower.includes("kurir"))) {
    statusClass = "status-highlight";
  } else if (statusLower.includes("terima") || statusLower.includes("delivered") || statusLower.includes("diterima")) {
    statusClass = "status-delivered";
  } else if (statusLower.includes("perjalanan") || statusLower.includes("transit") || statusLower.includes("diantar") || statusLower.includes("dalam perjalanan")) {
    statusClass = "status-transit";
  } else if (statusLower.includes("jemput") || statusLower.includes("pickup") || statusLower.includes("ambil") || statusLower.includes("dijemput")) {
    statusClass = "status-pickup";
  } else {
    statusClass = "status-other";
  }

  let html = `
    <div class="result-card-header">
      <div class="result-card-awb-section">
        <div>
          <div class="result-card-awb-label">NO. RESI (AWB)</div>
          <div class="result-card-awb">${escapeXml(awbDisplay)}</div>
        </div>
        <button class="btn-copy${isCopied ? " copied" : ""}" title="${isCopied ? "Sudah disalin" : "Salin nomor resi"}" data-awb="${escapeXml(item.awb)}">${isCopied ? "✓" : "📋"}</button>
      </div>
      <div class="result-card-status ${statusClass}">${escapeXml(item.status)}</div>
    </div>
    <div class="result-card-info-label">INFORMASI PENGIRIMAN</div>
    <div class="result-card-grid">
      <div class="result-field-row"><span class="result-field-label">TANGGAL</span><span class="result-field-value value-mono">${escapeXml(item.tanggal)}</span></div>
      <div class="result-field-row"><span class="result-field-label">JAM</span><span class="result-field-value value-mono">${escapeXml(item.jam)}</span></div>
      <div class="result-field-row"><span class="result-field-label">PENGIRIM</span><span class="result-field-value">${escapeXml(item.sender || "-")}</span></div>
      <div class="result-field-row"><span class="result-field-label">PENERIMA</span><span class="result-field-value">${escapeXml(item.receiver)}</span></div>
      <div class="result-field-row"><span class="result-field-label">ALMT. PENGIRIM</span><span class="result-field-value">${escapeXml(item.senderAddress || "-")}</span></div>
      <div class="result-field-row"><span class="result-field-label">ALMT. PENERIMA</span><span class="result-field-value">${escapeXml(item.receiverAddress || "-")}</span></div>
    </div>
    <hr class="result-card-divider">
  `;

  if (item.history && item.history.length > 0) {
    const historyId = "hist-" + Math.random().toString(36).substring(7);
    html += `<span class="history-toggle" onclick="document.getElementById('${historyId}').classList.toggle('hidden')">detail ▾</span>`;
    html += `<div class="history-list hidden" id="${historyId}">`;
    for (const h of item.history) {
      html += `
        <div class="history-item">
          <div class="history-dot"></div>
          <div class="history-content">
            <div class="history-date">${escapeXml(h.date)}</div>
            <div class="history-desc">${escapeXml(h.description)}</div>
            <div class="history-location">${escapeXml(h.location)}</div>
          </div>
        </div>
      `;
    }
    html += `</div>`;
  }

  card.innerHTML = html;

  // Wire copy button
  const copyBtn = card.querySelector(".btn-copy");
  if (copyBtn) {
    copyBtn.onclick = () => {
      navigator.clipboard.writeText(item.awb).then(() => {
        copiedAwbs.add(item.awb);           // persistent
        copyBtn.textContent = "✓";
        copyBtn.classList.add("copied");
        copyBtn.title = "Sudah disalin";
      });
    };
  }

  return card;
}

function updateStats(duration, scanned = 0) {
  document.getElementById("txtTotalResi").textContent = results.length;
  const success = results.filter(r => {
    const s = (r.status || "").toLowerCase();
    const failed = s.startsWith("gagal") || s.startsWith("error") || s.includes("failed");
    const spxWithoutStatus = COURIER === "spx" && (s === "belum ada status" || s === "tidak ditemukan");
    return !failed && !spxWithoutStatus;
  }).length;
  document.getElementById("txtBerhasil").textContent = success;
  document.getElementById("txtDipindai").textContent = scanned || 0;
}

function formatDuration(ms) {
  const totalSec = Math.floor(ms / 1000);
  const h = String(Math.floor(totalSec / 3600)).padStart(2, "0");
  const m = String(Math.floor((totalSec % 3600) / 60)).padStart(2, "0");
  const s = String(totalSec % 60).padStart(2, "0");
  return `${h}:${m}:${s}`;
}

function setButtonsDisabled(disabled) {
  document.getElementById("btnTrack").disabled = disabled;
  if (disabled) {
    document.getElementById("btnTrackSearch").classList.add("hidden");
    const btnPause = document.getElementById("btnPause");
    btnPause.classList.remove("hidden");
    btnPause.innerHTML = "⏸ Pause";
    btnPause.onclick = btnPauseClick;
    document.getElementById("btnScanRow").classList.remove("hidden");
    document.getElementById("btnNext").classList.add("hidden");
  } else {
    document.getElementById("btnTrackSearch").classList.remove("hidden");
    document.getElementById("btnPause").classList.add("hidden");
    document.getElementById("btnScanRow").classList.add("hidden");
  }
}

function showNextButton() {
  document.getElementById("btnPause").classList.add("hidden");
  document.getElementById("btnNext").classList.remove("hidden");
}
function hideNextButton() {
  document.getElementById("btnPause").classList.remove("hidden");
  document.getElementById("btnNext").classList.add("hidden");
}

function waitForNext() {
  return new Promise(resolve => {
    nextResolver = (proceed) => { nextResolver = null; resolve(proceed); };
  });
}

// ═══════════════════════════════════════════════════════
// LOG SYSTEM — text buffer, zero DOM alloc per entry
// ═══════════════════════════════════════════════════════
const LOG_MAX_CHARS = 32000;
let _logMinimal = false; // Minimal mode: only show match/error
let _logAllLines = [];  // Full log buffer for minimal mode toggle

function log(msg, type = "info") {
  const timestamp = new Date().toTimeString().substring(0, 8);
  const text = `[${timestamp}] ${msg}`;
  _logAllLines.push({ text, type });
  // Cap full buffer
  if (_logAllLines.length > 2000) _logAllLines = _logAllLines.slice(-1000);

  if (_logMinimal && !isMinimalType(type)) return;

  logQueue.push({ text, type });
  if (!logRafId) logRafId = requestAnimationFrame(flushLogQueue);
}

function isMinimalType(type) {
  return type === "success" || type === "warning" || type === "error";
}

function clearLog() {
  _logAllLines = [];
  logQueue = [];
  const body = document.getElementById("logBody");
  if (body) body.innerHTML = "";
  log("Log dibersihkan.", "system");
}

function toggleMinimalLog() {
  _logMinimal = !_logMinimal;
  const btn = document.getElementById("btnMinimalLog");
  const subtitle = document.getElementById("logSubtitle");
  if (_logMinimal) {
    btn.classList.add("active");
    if (subtitle) subtitle.textContent = "Mode minimal: hanya Match/Error";
    // Rebuild log from full buffer
    rebuildLogFromBuffer();
  } else {
    btn.classList.remove("active");
    if (subtitle) subtitle.textContent = "Realtime output proses AWB";
    rebuildLogFromBuffer();
  }
}

function rebuildLogFromBuffer() {
  const body = document.getElementById("logBody");
  if (!body) return;
  logQueue = _logAllLines
    .filter(e => !_logMinimal || isMinimalType(e.type))
    .slice(-600);
  logRafId = requestAnimationFrame(flushLogQueue);
}

const LOG_COLORS = {
  success: "log-success",
  error: "log-error",
  warning: "log-warning",
  system: "log-system",
  info: "log-info"
};

function renderLogLine(entry) {
  const cls = LOG_COLORS[entry.type] || LOG_COLORS.info;
  return `<div class="log-line ${cls}">${escapeXml(entry.text)}</div>`;
}

function flushLogQueue() {
  logRafId = null;
  if (logQueue.length === 0) return;
  const body = document.getElementById("logBody");
  if (!body) { logQueue = []; return; }

  let html = "";
  while (logQueue.length > 0) {
    const entry = logQueue.shift();
    html += renderLogLine(entry);
  }

  body.innerHTML += html;

  // Cap by line count — trim from top
  const lines = body.querySelectorAll(".log-line");
  if (lines.length > 800) {
    for (let i = 0; i < lines.length - 600; i++) {
      lines[i].remove();
    }
  }

  body.scrollTop = body.scrollHeight;


}

// ═══════════════════════════════════════════════════════
// KOTA AUTOCOMPLETE — populate datalist from ML data
// ═══════════════════════════════════════════════════════
function populateKotaAutocomplete() {
  const datalist = document.getElementById("kotaList");
  if (!datalist || !ml) return;

  const suggestions = new Set();

  // 1. From cityKdes keys (normalized — convert to Title Case)
  for (const key of Object.keys(ml.cityKdes)) {
    const title = key.replace(/\b\w/g, c => c.toUpperCase());
    suggestions.add(title);
  }

  // 2. From history destinations (unique full strings)
  const seenDest = new Set();
  for (const h of ml.history) {
    if (!h.destination || seenDest.has(h.destination)) continue;
    seenDest.add(h.destination);
    // Extract city part
    const parts = h.destination.split(",").map(s => s.trim());
    if (parts.length >= 2) {
      suggestions.add(parts[parts.length - 1]); // City only
    } else {
      suggestions.add(h.destination); // Fallback if no comma
    }
  }

  // Build datalist options — filter Jakarta only
  const sorted = [...suggestions].filter(s => s.toLowerCase().includes("jakarta")).sort();
  datalist.innerHTML = sorted.map(s => `<option value="${s.replace(/"/g, "&quot;")}">`).join("");

  log(`Autocomplete kota: ${sorted.length} saran dimuat.`, "system");
}

// ═══════════════════════════════════════════════════════
// CONCURRENCY HELPERS
// ═══════════════════════════════════════════════════════
async function acquireSemaphore(sem) {
  while (sem.current >= sem.max)
    await new Promise(r => setTimeout(r, 10));
  sem.current++;
}

function releaseSemaphore(sem) {
  sem.current--;
}

// ═══════════════════════════════════════════════════════
// MUSIC PLAYER
// ═══════════════════════════════════════════════════════
let musicPlaylist = [];
let musicCurrentIndex = -1;
let musicAudio = null;
let musicIsPlaying = false;
let musicVolume = 0.8;
let musicRepeat = false;

// WebAudio API objects
let audioCtx = null;
let analyser = null;
let audioSource = null;
let vizDataArray = null;
let vizAnimFrame = null;

async function initMusicPlayer() {
  try {
    const res = await fetch("/api/music?action=list", { cache: "no-store" });
    if (!res.ok) throw new Error("Failed to load playlist");
    musicPlaylist = await res.json();

    // Populate dropdown
    const sel = document.getElementById("musicPlaylist");
    musicPlaylist.forEach((t, i) => {
      const opt = document.createElement("option");
      opt.value = i;
      opt.textContent = `${t.title} — ${t.artist}`;
      sel.appendChild(opt);
    });

    setupMusicPlayer();
  } catch (err) {
    console.log("Music player init skipped:", err.message);
  }
}

function setupMusicPlayer() {
  musicAudio = new Audio();
  musicAudio.crossOrigin = "anonymous"; // Needed for WebAudio analyser
  musicAudio.volume = musicVolume;
  musicAudio.preload = "metadata";

  // Event listeners
  musicAudio.addEventListener("timeupdate", updateMusicProgress);
  musicAudio.addEventListener("ended", () => {
    if (musicRepeat) {
      musicAudio.currentTime = 0;
      musicAudio.play();
    } else {
      playNextTrack();
    }
  });
  musicAudio.addEventListener("loadedmetadata", updateMusicTimeDisplay);
  musicAudio.addEventListener("error", (e) => {
    console.warn("Music load error:", e);
  });

  const popup = document.getElementById("musicPopup");
  const toggle = document.getElementById("musicToggle");

  // Toggle popup
  toggle.onclick = () => {
    const show = !popup.classList.contains("show");
    popup.classList.toggle("show", show);
    toggle.classList.toggle("active", show);
  };

  // Close button
  document.getElementById("musicClose").onclick = () => {
    popup.classList.remove("show");
    toggle.classList.remove("active");
  };

  // Drag
  const handle = document.getElementById("musicDragHandle");
  let isDragging = false, offsetX, offsetY;
  handle.addEventListener("mousedown", (e) => {
    if (e.target.id === "musicClose") return;
    isDragging = true;
    offsetX = e.clientX - popup.offsetLeft;
    offsetY = e.clientY - popup.offsetTop;
    popup.style.transition = "none";
  });
  document.addEventListener("mousemove", (e) => {
    if (!isDragging) return;
    popup.style.left = (e.clientX - offsetX) + "px";
    popup.style.top = (e.clientY - offsetY) + "px";
    popup.style.right = "auto";
  });
  document.addEventListener("mouseup", () => {
    isDragging = false;
    popup.style.transition = "";
  });

  // Controls
  document.getElementById("musicPlay").onclick = toggleMusicPlay;
  document.getElementById("musicPrev").onclick = playPrevTrack;
  document.getElementById("musicNext").onclick = playNextTrack;
  document.getElementById("musicStop").onclick = stopTrack;
  document.getElementById("musicRepeat").onclick = () => {
    musicRepeat = !musicRepeat;
    document.getElementById("musicRepeat").classList.toggle("active", musicRepeat);
  };

  // Progress seek
  document.getElementById("musicProgress").oninput = (e) => {
    if (!musicAudio || !musicAudio.duration) return;
    musicAudio.currentTime = (parseFloat(e.target.value) / 1000) * musicAudio.duration;
  };

  // Volume
  document.getElementById("musicVolume").oninput = (e) => {
    const vol = parseInt(e.target.value) / 100;
    musicVolume = vol;
    musicAudio.volume = vol;
    document.getElementById("musicVolumePct").textContent = Math.round(vol * 100) + "%";
    document.getElementById("musicMuteIcon").textContent = vol === 0 ? "🔇" : "🔊";
  };

  // Mute toggle
  document.getElementById("musicMuteIcon").onclick = () => {
    if (musicAudio.volume > 0) {
      musicAudio.volume = 0;
      document.getElementById("musicVolume").value = 0;
      document.getElementById("musicVolumePct").textContent = "0%";
      document.getElementById("musicMuteIcon").textContent = "🔇";
    } else {
      musicAudio.volume = musicVolume || 0.8;
      document.getElementById("musicVolume").value = Math.round(musicAudio.volume * 100);
      document.getElementById("musicVolumePct").textContent = Math.round(musicAudio.volume * 100) + "%";
      document.getElementById("musicMuteIcon").textContent = "🔊";
    }
  };

  // Playlist dropdown
  document.getElementById("musicPlaylist").onchange = (e) => {
    const idx = parseInt(e.target.value);
    if (!isNaN(idx)) {
      loadTrack(idx).then(() => playTrack());
    }
  };

  // Keyboard: M to toggle play/pause
  document.addEventListener("keydown", (e) => {
    if (e.key === "m" || e.key === "M") {
      if (document.activeElement.tagName !== "INPUT" && document.activeElement.tagName !== "TEXTAREA") {
        e.preventDefault();
        toggleMusicPlay();
      }
    }
  });
}

async function loadTrack(index) {
  if (index < 0 || index >= musicPlaylist.length) return;
  musicCurrentIndex = index;
  const track = musicPlaylist[index];

  // Get presigned URL from API
  try {
    const res = await fetch("/api/music?action=url&key=" + encodeURIComponent(track.key));
    const data = await res.json();
    if (data.url) {
      musicAudio.src = data.url;
      musicAudio.load();
      updateMusicUI();
    }
  } catch (err) {
    console.warn("Failed to get presigned URL:", err);
  }
}

function playTrack() {
  if (!musicAudio) return;
  initWebAudio();
  musicAudio.play().catch(err => console.warn("Music play failed:", err));
  musicIsPlaying = true;
  updateMusicUI();
  startVisualizer();
}

function pauseTrack() {
  if (!musicAudio) return;
  musicAudio.pause();
  musicIsPlaying = false;
  updateMusicUI();
  stopVisualizer();
}

function stopTrack() {
  if (!musicAudio) return;
  musicAudio.pause();
  musicAudio.currentTime = 0;
  musicIsPlaying = false;
  updateMusicUI();
  updateMusicTimeDisplay();
  stopVisualizer();
}

function toggleMusicPlay() {
  if (!musicAudio) return;
  if (musicIsPlaying) pauseTrack();
  else {
    // If no track loaded, load first
    if (musicCurrentIndex < 0 && musicPlaylist.length > 0) {
      loadTrack(0).then(() => playTrack());
    } else {
      playTrack();
    }
  }
}

function playNextTrack() {
  if (musicPlaylist.length === 0) return;
  const next = (musicCurrentIndex + 1) % musicPlaylist.length;
  loadTrack(next).then(() => playTrack());
}

function playPrevTrack() {
  if (musicPlaylist.length === 0) return;
  const prev = (musicCurrentIndex - 1 + musicPlaylist.length) % musicPlaylist.length;
  loadTrack(prev).then(() => playTrack());
}

function updateMusicProgress() {
  if (!musicAudio || !musicAudio.duration) return;
  const percent = (musicAudio.currentTime / musicAudio.duration) * 1000;
  document.getElementById("musicProgress").value = percent;
  updateMusicTimeDisplay();
}

function updateMusicTimeDisplay() {
  if (!musicAudio) return;
  const cur = formatTime(musicAudio.currentTime || 0);
  const dur = formatTime(musicAudio.duration || 0);
  document.getElementById("musicTime").textContent = `${cur} / ${dur}`;
}

function formatTime(sec) {
  if (isNaN(sec) || !isFinite(sec)) return "0:00";
  const m = Math.floor(sec / 60);
  const s = Math.floor(sec % 60).toString().padStart(2, "0");
  return `${m}:${s}`;
}

// ═══════════════════════════════════════════════════════
// WEB AUDIO VISUALIZER — Canvas Bar Spectrum (6-color neon)
// ═══════════════════════════════════════════════════════
function initWebAudio() {
  if (audioCtx) return;
  try {
    audioCtx = new (window.AudioContext || window.webkitAudioContext)();
    analyser = audioCtx.createAnalyser();
    analyser.fftSize = 256;
    analyser.smoothingTimeConstant = 0.75;
    audioSource = audioCtx.createMediaElementSource(musicAudio);
    audioSource.connect(analyser);
    analyser.connect(audioCtx.destination);
    vizDataArray = new Uint8Array(analyser.frequencyBinCount);
  } catch (err) {
    console.warn("WebAudio init failed (CORS or unsupported):", err);
  }
}

// 6-color neon palette: cyan → electric blue → purple → hot pink → red → neon green
const VIZ_COLORS = [
  [0, 229, 255],    // #00e5ff cyan
  [64, 64, 255],    // #4040ff electric blue
  [138, 43, 226],   // #8a2be2 purple
  [255, 15, 168],   // #ff0fa8 hot pink
  [255, 68, 68],    // #ff4444 red
  [57, 255, 20],    // #39ff14 neon green
];

function getBarColor(barIndex, totalBars) {
  // Map bar position to color palette with smooth interpolation
  const t = barIndex / Math.max(1, totalBars - 1);
  const segCount = VIZ_COLORS.length - 1;
  const segment = Math.min(segCount - 1, Math.floor(t * segCount));
  const local = (t * segCount) - segment;
  const c1 = VIZ_COLORS[segment];
  const c2 = VIZ_COLORS[segment + 1];
  return [
    Math.round(c1[0] + (c2[0] - c1[0]) * local),
    Math.round(c1[1] + (c2[1] - c1[1]) * local),
    Math.round(c1[2] + (c2[2] - c1[2]) * local),
  ];
}

function startVisualizer() {
  if (!analyser) return;
  if (audioCtx.state === 'suspended') audioCtx.resume();

  const canvas = document.getElementById("musicVizCanvas");
  if (!canvas) return;
  const ctx = canvas.getContext("2d");

  function draw() {
    vizAnimFrame = requestAnimationFrame(draw);

    // Resize canvas to match popup (retina-aware)
    const popup = canvas.parentElement;
    const w = popup.offsetWidth;
    const h = popup.offsetHeight;
    const dpr = window.devicePixelRatio || 1;
    if (canvas.width !== w * dpr || canvas.height !== h * dpr) {
      canvas.width = w * dpr;
      canvas.height = h * dpr;
      ctx.scale(dpr, dpr);
    }
    ctx.clearRect(0, 0, w, h);

    analyser.getByteFrequencyData(vizDataArray);

    const binCount = analyser.frequencyBinCount; // 128
    const barCount = Math.min(48, binCount);      // 48 bars max for clean look
    const gap = 2;
    const barW = Math.max(2, (w - gap * (barCount + 1)) / barCount);
    const startX = (w - (barW + gap) * barCount + gap) / 2; // center bars

    for (let i = 0; i < barCount; i++) {
      // Sample from frequency data (spread across bins)
      const dataIndex = Math.floor((i / barCount) * binCount);
      const val = vizDataArray[dataIndex] / 255;
      const barH = Math.max(2, val * h * 0.85);
      const x = startX + i * (barW + gap);
      const y = h - barH;

      const [r, g, b] = getBarColor(i, barCount);

      // Vertical gradient: darker at bottom, brighter at top
      const grad = ctx.createLinearGradient(x, h, x, y);
      grad.addColorStop(0, `rgba(${r},${g},${b},0.15)`);
      grad.addColorStop(0.5, `rgba(${r},${g},${b},0.6)`);
      grad.addColorStop(1, `rgba(${r},${g},${b},1)`);

      ctx.fillStyle = grad;

      // Rounded top bar
      const radius = Math.min(barW / 2, 3);
      ctx.beginPath();
      ctx.moveTo(x, h);
      ctx.lineTo(x, y + radius);
      ctx.quadraticCurveTo(x, y, x + radius, y);
      ctx.lineTo(x + barW - radius, y);
      ctx.quadraticCurveTo(x + barW, y, x + barW, y + radius);
      ctx.lineTo(x + barW, h);
      ctx.closePath();
      ctx.fill();

      // Glow cap at top of each bar
      if (val > 0.15) {
        ctx.shadowColor = `rgba(${r},${g},${b},0.6)`;
        ctx.shadowBlur = 6;
        ctx.fillStyle = `rgba(${r},${g},${b},0.9)`;
        ctx.fillRect(x, y, barW, 2);
        ctx.shadowBlur = 0;
      }
    }
  }
  draw();
}

function stopVisualizer() {
  if (vizAnimFrame) cancelAnimationFrame(vizAnimFrame);
  vizAnimFrame = null;
  const canvas = document.getElementById("musicVizCanvas");
  if (canvas) {
    const ctx = canvas.getContext("2d");
    ctx.clearRect(0, 0, canvas.width, canvas.height);
  }
}

function updateMusicUI() {
  if (musicPlaylist.length === 0 || musicCurrentIndex < 0) return;
  const track = musicPlaylist[musicCurrentIndex];
  document.getElementById("musicNowPlaying").textContent = `${track.title} — ${track.artist}`;
  document.getElementById("musicPlay").textContent = musicIsPlaying ? "⏸" : "▶";
  document.getElementById("musicPlay").title = musicIsPlaying ? "Pause" : "Play";
  document.getElementById("musicPlaylist").value = musicCurrentIndex;
}