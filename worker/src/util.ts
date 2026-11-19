export const TZ_OFF = 12600; // Asia/Tehran, UTC+03:30 (no DST)
export const now = () => Date.now() / 1000;
const FA_MAP: Record<string, string> = {};
"۰۱۲۳۴۵۶۷۸۹".split("").forEach((c, i) => (FA_MAP[c] = String(i)));
"٠١٢٣٤٥٦٧٨٩".split("").forEach((c, i) => (FA_MAP[c] = String(i)));
export const norm = (s: any) => String(s ?? "").replace(/[۰-۹٠-٩]/g, (c) => FA_MAP[c]).trim();
export const fa = (n: any) => String(n).replace(/[0-9]/g, (d) => "۰۱۲۳۴۵۶۷۸۹"[Number(d)]);
export const esc = (s: any) => String(s ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#x27;");
/** Python truthiness */
export const T = (x: any) => !(x === null || x === undefined || x === false || x === 0 || x === "" || (Array.isArray(x) && !x.length) || (typeof x === "object" && !Array.isArray(x) && !Object.keys(x).length));
export const pyRound = (x: number) => { const f = Math.floor(x), r = x - f; if (r > 0.5) return f + 1; if (r < 0.5) return f; return f % 2 === 0 ? f : f + 1; };
export const pad2 = (n: number) => String(n).padStart(2, "0");
/** Tehran wall-clock parts for a unix ts */
export function teh(ts: number) {
  const d = new Date((ts + TZ_OFF) * 1000);
  return { y: d.getUTCFullYear(), mo: d.getUTCMonth() + 1, d: d.getUTCDate(), h: d.getUTCHours(), mi: d.getUTCMinutes() };
}
export const tehTs = (y: number, mo: number, d: number, h: number, mi: number) => Date.UTC(y, mo - 1, d, h, mi) / 1000 - TZ_OFF;
export function stripChars(s: string, chars: string) {
  let a = 0, b = s.length;
  while (a < b && chars.includes(s[a])) a++;
  while (b > a && chars.includes(s[b - 1])) b--;
  return s.slice(a, b);
}
export const escRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
export const choice = <T,>(a: T[]) => a[Math.floor(Math.random() * a.length)];
export const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
export function token(nbytes = 9) {
  const b = crypto.getRandomValues(new Uint8Array(nbytes));
  return btoa(String.fromCharCode(...b)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}
export const words = (s: string) => (s || "").split(/\s+/).filter(Boolean);
