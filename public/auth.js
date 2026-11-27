// ═══════════════════════════════════════════════════════
// auth.js — Login module (glass morphism, single kode akses)
// ═══════════════════════════════════════════════════════

const AUTH_KEY = "awb_auth";
const AUTH_API = "/api/auth";
const DEVICE_ID_KEY = "awb_device_id";
const SESSION_VERSION = 2; // Bump ini untuk force logout semua user

// ── State ──
let authUser = null;
let _onLogin = null;

// ── Device ID ──
function getOrCreateDeviceId() {
  try {
    let deviceId = localStorage.getItem(DEVICE_ID_KEY);
    if (deviceId) return deviceId;
    
    // Generate device ID
    if (typeof crypto !== "undefined" && crypto.randomUUID) {
      deviceId = crypto.randomUUID();
    } else {
      // Fallback: kombinasi user agent + screen + timezone + random
      const ua = navigator.userAgent || "";
      const screen = `${window.screen.width}x${window.screen.height}`;
      const tz = Intl.DateTimeFormat().resolvedOptions().timeZone || "";
      const rand = Math.random().toString(36).substring(2, 15);
      deviceId = btoa(`${ua}|${screen}|${tz}|${rand}`).replace(/[^a-zA-Z0-9]/g, "").substring(0, 32);
    }
    
    localStorage.setItem(DEVICE_ID_KEY, deviceId);
    return deviceId;
  } catch {
    return "unknown-device";
  }
}

// ── Init ──
export function initAuth(onLogin) {
  _onLogin = onLogin;
  const hostname = window.location.hostname;
  const isPreview =
    hostname === "localhost" ||
    hostname === "127.0.0.1" ||
    hostname.endsWith(".app.github.dev");
  if (isPreview) {
    authUser = {
      username: "Preview",
      tipe: "preview",
      sessionVersion: SESSION_VERSION,
      expires: Date.now() + 24 * 60 * 60 * 1000,
    };
    if (onLogin) setTimeout(onLogin, 0);
    return true;
  }
  authUser = loadAuth();
  if (authUser) {
    if (onLogin) setTimeout(onLogin, 0);
    return true;
  }
  showLoginOverlay();
  return false;
}

export function getAuthUser() {
  return authUser;
}

function loadAuth() {
  try {
    const raw = localStorage.getItem(AUTH_KEY);
    if (!raw) return null;
    const data = JSON.parse(raw);
    const now = Date.now();
    
    // Check session version
    if (data.sessionVersion !== SESSION_VERSION) {
      localStorage.removeItem(AUTH_KEY);
      return null;
    }
    
    if (data.expires && data.expires < now) {
      localStorage.removeItem(AUTH_KEY);
      return null;
    }
    return data;
  } catch {
    return null;
  }
}

function saveAuth(username, tipe) {
  const data = {
    username,
    tipe,
    sessionVersion: SESSION_VERSION,
    expires: Date.now() + 24 * 60 * 60 * 1000,
  };
  localStorage.setItem(AUTH_KEY, JSON.stringify(data));
  authUser = data;
}

export function logout() {
  localStorage.removeItem(AUTH_KEY);
  authUser = null;
  showLoginOverlay();
}

// ── Login Overlay ──
function showLoginOverlay() {
  const existing = document.getElementById("loginOverlay");
  if (existing) existing.remove();

  const overlay = document.createElement("div");
  overlay.id = "loginOverlay";
  overlay.className = "login-overlay";
  overlay.innerHTML = `
    <div class="login-bg">
      <div class="login-dotgrid"></div>
      <div class="login-glow"></div>
      <div class="login-corner login-corner-tl"></div>
      <div class="login-corner login-corner-tr"></div>
      <div class="login-corner login-corner-bl"></div>
      <div class="login-corner login-corner-br"></div>
      <div class="login-line login-line-left"></div>
      <div class="login-line login-line-right"></div>
    </div>
    <div class="login-card">
      <div class="login-logo">
        <svg class="login-ring-outer" viewBox="0 0 100 100">
          <circle cx="50" cy="50" r="46" fill="none" stroke="#00D8FF" stroke-width="1" stroke-dasharray="1,6" opacity="0.35"/>
        </svg>
        <svg class="login-ring-inner" viewBox="0 0 100 100">
          <circle cx="50" cy="50" r="36" fill="none" stroke="#00D8FF" stroke-width="1.2" stroke-dasharray="10,5" opacity="0.45"/>
        </svg>
        <div class="login-orbit">
          <div class="login-orbit-dot"></div>
        </div>
        <img src="New-AWB.png" alt="SiCepat Jinxpro" class="login-logo-icon">
      </div>
      <h2 class="login-title">SICEPAT JINXPRO</h2>
      <p class="login-subtitle">Masukkan kode akses untuk melanjutkan</p>

      <div class="login-field">
        <label class="login-label">Kode Akses</label>
        <input id="loginKodeAkses" type="text" class="login-input" placeholder="AWB-XXXX-XXXX-XXXX-XXXX" autocomplete="off" spellcheck="false">
      </div>

      <div id="loginError" class="login-error hidden"></div>

      <button id="loginBtn" class="login-btn">
        <span class="login-btn-text">Masuk</span>
        <span class="login-btn-spinner hidden"></span>
      </button>

      <a href="https://wa.me/6288229143977" target="_blank" class="login-wa-link">
        <svg viewBox="0 0 24 24" width="14" height="14" fill="currentColor"><path d="M17.472 14.382c-.297-.149-1.758-.867-2.03-.967-.273-.099-.471-.148-.67.15-.197.297-.767.966-.94 1.164-.173.199-.347.223-.644.075-.297-.15-1.255-.463-2.39-1.475-.883-.788-1.48-1.761-1.653-2.059-.173-.297-.018-.458.13-.606.134-.133.298-.347.446-.52.149-.174.198-.298.298-.497.099-.198.05-.371-.025-.52-.075-.149-.669-1.612-.916-2.207-.242-.579-.487-.5-.669-.51-.173-.008-.371-.01-.57-.01-.198 0-.52.074-.792.372-.272.297-1.04 1.016-1.04 2.479 0 1.462 1.065 2.875 1.213 3.074.149.198 2.096 3.2 5.077 4.487.709.306 1.262.489 1.694.625.712.227 1.36.195 1.871.118.571-.085 1.758-.719 2.006-1.413.248-.694.248-1.289.173-1.413-.074-.124-.272-.198-.57-.347m-5.421 7.403h-.004a9.87 9.87 0 01-5.031-1.378l-.361-.214-3.741.982.998-3.648-.235-.374a9.86 9.86 0 01-1.51-5.26c.001-5.45 4.436-9.884 9.888-9.884 2.64 0 5.122 1.03 6.988 2.898a9.825 9.825 0 012.893 6.994c-.003 5.45-4.437 9.884-9.885 9.884m8.413-18.297A11.815 11.815 0 0012.05 0C5.495 0 .16 5.335.157 11.892c0 2.096.547 4.142 1.588 5.945L.057 24l6.305-1.654a11.882 11.882 0 005.683 1.448h.005c6.554 0 11.89-5.335 11.893-11.893a11.821 11.821 0 00-3.48-8.413z"/></svg>
        Support & Order
      </a>
    </div>
  `;

  document.body.appendChild(overlay);

  // Events
  const kodeEl = document.getElementById("loginKodeAkses");
  const btn = document.getElementById("loginBtn");
  const errorEl = document.getElementById("loginError");

  btn.addEventListener("click", () => doLogin(kodeEl, btn, errorEl));
  kodeEl.addEventListener("keydown", (e) => {
    if (e.key === "Enter") doLogin(kodeEl, btn, errorEl);
  });

  setTimeout(() => kodeEl.focus(), 300);
}

async function doLogin(kodeEl, btn, errorEl) {
  const kodeAkses = kodeEl.value.trim();

  if (!kodeAkses) {
    showError(errorEl, "Kode akses wajib diisi");
    return;
  }

  setLoading(btn, true);
  hideError(errorEl);

  try {
    const deviceId = getOrCreateDeviceId();
    const resp = await fetch(AUTH_API, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ kodeAkses, deviceId }),
    });

    const data = await resp.json();

    if (data.ok) {
      saveAuth(data.username, data.tipe);
      const overlay = document.getElementById("loginOverlay");
      if (overlay) {
        overlay.classList.add("login-overlay-out");
        setTimeout(() => {
          overlay.remove();
          if (_onLogin) _onLogin();
        }, 400);
      }
    } else {
      showError(errorEl, data.message || "Kode akses tidak valid");
    }
  } catch (err) {
    showError(errorEl, "Gagal terhubung. Coba lagi.");
  } finally {
    setLoading(btn, false);
  }
}

function setLoading(btn, loading) {
  const text = btn.querySelector(".login-btn-text");
  const spinner = btn.querySelector(".login-btn-spinner");
  if (loading) {
    text.classList.add("hidden");
    spinner.classList.remove("hidden");
    btn.disabled = true;
  } else {
    text.classList.remove("hidden");
    spinner.classList.add("hidden");
    btn.disabled = false;
  }
}

function showError(el, msg) {
  el.textContent = msg;
  el.classList.remove("hidden");
  el.classList.add("login-error-shake");
  setTimeout(() => el.classList.remove("login-error-shake"), 500);
}

function hideError(el) {
  el.classList.add("hidden");
  el.textContent = "";
}