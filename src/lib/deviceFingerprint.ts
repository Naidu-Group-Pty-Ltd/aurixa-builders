// Stable per-browser fingerprint used by the Mission Control device cap.
// Persists in localStorage so the same browser keeps the same seat slot
// across sign-ins. Mirrors the spec in
// docs/mission-control-device-cap.md.

const FP_KEY = "aurixa.device.fp";
const DEVICE_ID_KEY = "aurixa.device.id";

export function getDeviceFingerprint(): string {
  try {
    const existing = localStorage.getItem(FP_KEY);
    if (existing) return existing;
    const seed = [
      navigator.userAgent,
      navigator.language,
      `${screen.width}x${screen.height}`,
      Intl.DateTimeFormat().resolvedOptions().timeZone,
      // Anchor with a stable random value so two browsers with identical UA
      // (e.g. two private windows) still get distinct fingerprints.
      crypto.randomUUID(),
    ].join("|");
    const fp = btoa(seed).replace(/[^A-Za-z0-9]/g, "").slice(0, 64);
    localStorage.setItem(FP_KEY, fp);
    return fp;
  } catch {
    // Storage unavailable — fall back to a per-tab id (not stable across reloads).
    return `nostore-${crypto.randomUUID().replace(/-/g, "").slice(0, 32)}`;
  }
}

export function getDeviceLabel(): string {
  const ua = navigator.userAgent;
  if (/iPad/.test(ua)) return "iPad";
  if (/iPhone/.test(ua)) return "iPhone";
  if (/Android/.test(ua)) return "Android";
  if (/Mac OS X|Macintosh/.test(ua)) return "macOS";
  if (/Windows/.test(ua)) return "Windows";
  if (/Linux/.test(ua)) return "Linux";
  return "Browser";
}

export function getStoredDeviceId(): string | null {
  try { return sessionStorage.getItem(DEVICE_ID_KEY) || localStorage.getItem(DEVICE_ID_KEY); }
  catch { return null; }
}

export function persistDeviceId(id: string) {
  try { sessionStorage.setItem(DEVICE_ID_KEY, id); } catch { /* ignore */ }
  try { localStorage.setItem(DEVICE_ID_KEY, id); } catch { /* ignore */ }
}

export function clearDeviceId() {
  try { sessionStorage.removeItem(DEVICE_ID_KEY); } catch { /* ignore */ }
  try { localStorage.removeItem(DEVICE_ID_KEY); } catch { /* ignore */ }
}
