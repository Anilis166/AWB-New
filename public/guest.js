const GUEST_ID_KEY = "awb_guest_id";
let guestUser = null;

function createGuestId() {
  const cryptoApi = globalThis.crypto;
  if (cryptoApi?.randomUUID) return cryptoApi.randomUUID();
  if (!cryptoApi?.getRandomValues) return Math.random().toString(36).slice(2);
  return Array.from(cryptoApi.getRandomValues(new Uint8Array(16)))
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

export function getGuestUser() {
  if (guestUser) return guestUser;

  let username;
  try {
    username = localStorage.getItem(GUEST_ID_KEY);
    if (!username) {
      username = `guest-${createGuestId()}`;
      localStorage.setItem(GUEST_ID_KEY, username);
    }
  } catch {
    username = `guest-${createGuestId()}`;
  }

  guestUser = { username, tipe: "guest" };
  return guestUser;
}
