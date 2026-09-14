/** Shared date/currency formatting for the Passport presentation family. */

export function formatStampDate(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleDateString("en-AU", { day: "2-digit", month: "short", year: "numeric" }).toUpperCase();
}

/**
 * The date line the design prints across a stamp face: `13 AUG 2026 · 09:27`.
 * A stamp records an instant, and the time is half of what makes it a record —
 * two stamps on the same day are ordered only by it.
 */
export function formatStampStruck(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  const time = d.toLocaleTimeString("en-AU", { hour: "2-digit", minute: "2-digit", hour12: false });
  return `${formatStampDate(iso)} · ${time}`;
}

export function formatPassportDate(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleDateString("en-AU", { day: "2-digit", month: "short", year: "numeric" });
}

export function formatPassportDateTime(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return `${formatPassportDate(iso)} · ${d.toLocaleTimeString("en-AU", { hour: "2-digit", minute: "2-digit" })}`;
}

export function formatPassportCurrency(n: number): string {
  return new Intl.NumberFormat("en-AU", { style: "currency", currency: "AUD", maximumFractionDigits: 0 }).format(n);
}
