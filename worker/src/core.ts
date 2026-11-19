import { Store, FU, Member } from "./store";
import { SYSTEM, LEVELS, FALLBACK, SELF_SYSTEM, STATUS, SPOKEN_HINT } from "./prompts";
import * as V from "./tts";
import { Gender, guessGender, genderHint, genderFix, normGender } from "./gender";
import { norm, fa, esc, T, pyRound, pad2, teh, tehTs, stripChars, escRe, choice, sleep, token, words, now } from "./util";

export interface Env { DB: D1Database; TELEGRAM_BOT_TOKEN: string; OPENROUTER_API_KEY: string; WEBHOOK_SECRET?: string; }
export type R = { env: Env; S: Store; botId: number; botUsername: string; sub: number; orKey: string };
export const MIN_GAP = 3600, MAX_ACTIVE = 5, MAX_PER_DAY = 5, LLM_PER_HOUR = 20;
const SUB_BUDGET = 46; // Workers Free: 50 outbound subrequests per invocation

export function mkR(env: Env, S: Store): R {
  const m = /sk-or-v1-[0-9a-fA-F]{20,}/.exec(env.OPENROUTER_API_KEY || "");
  return { env, S, botId: Number(String(env.TELEGRAM_BOT_TOKEN).split(":")[0]), botUsername: S.d.bot_username, sub: 0, orKey: m ? m[0] : String(env.OPENROUTER_API_KEY || "").trim() };
}
export const DB = (r: R) => r.S.d;
const log = (...a: any[]) => console.log(...a);

// ---------------- Telegram ----------------
export async function tg(r: R, method: string, params: any): Promise<any> {
  r.sub++;
  const resp = await fetch(`https://api.telegram.org/bot${r.env.TELEGRAM_BOT_TOKEN}/${method}`, {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(params),
  });
  const j: any = await resp.json().catch(() => ({ ok: false, description: `HTTP ${resp.status}` }));
  if (!j.ok) throw new Error(j.description || "telegram error");
  return j.result;
}
export async function tgVoice(r: R, params: Record<string, any>, audio: Uint8Array): Promise<any> {
  r.sub++;
  const fd = new FormData();
  for (const [k, v] of Object.entries(params)) if (v !== undefined && v !== null) fd.append(k, typeof v === "object" ? JSON.stringify(v) : String(v));
  fd.append("voice", new Blob([audio], { type: "audio/mpeg" }), "naser.mp3");
  const resp = await fetch(`https://api.telegram.org/bot${r.env.TELEGRAM_BOT_TOKEN}/sendVoice`, { method: "POST", body: fd });
  const j: any = await resp.json().catch(() => ({ ok: false, description: `HTTP ${resp.status}` }));
  if (!j.ok) throw new Error(j.description || "telegram error");
  return j.result;
}
export const replyParams = (mid?: number | null) => (mid ? { reply_parameters: { message_id: mid, allow_sending_without_reply: true } } : {});
export const isGroup = (chat: any) => chat && (chat.type === "group" || chat.type === "supergroup");
/** PTB Message.reply_text: quotes in groups, not in private */
export async function replyText(r: R, msg: any, text: string, kw: any = {}) {
  return tg(r, "sendMessage", { chat_id: msg.chat.id, text: text.slice(0, 4096), ...(isGroup(msg.chat) ? replyParams(msg.message_id) : {}), ...kw });
}
export const kb = (rows: [string, string][][]) => ({ inline_keyboard: rows.map((row) => row.map(([text, callback_data]) => ({ text, callback_data }))) });

// ---------------- DB helpers ----------------
export const isOwner = (r: R, u: any) => DB(r).owner !== null && u.id === DB(r).owner;
export const isAdmin = isOwner;
export const isBanned = (r: R, uid: number) => DB(r).banned.includes(uid);
export const canManage = (r: R, uid: number, fu: FU) => uid === DB(r).owner || fu.creator_id === uid;
export const ownFus = (r: R, uid: number, includeAllForAdmin = false) =>
  Object.values(DB(r).followups).filter((f) => f.creator_id === uid || (includeAllForAdmin && uid === DB(r).owner));
export function inScope(fu: FU, chat: any) {
  if (!chat || chat.type === "private") return true;
  return fu.mode === "group" && fu.target_chat_id === chat.id && !fu.self;
}
export const scoped = (fus: FU[], chat: any) => fus.filter((f) => inScope(f, chat));
export function whereLabel(r: R, fu: FU) {
  if (fu.mode === "group" && fu.target_chat_id) {
    const t = DB(r).groups[String(fu.target_chat_id)]?.title || "گروه";
    return `👥 گروه «${t}»`;
  }
  return "🔒 پیوی" + (fu.self ? " (یادآور شخصی)" : "");
}
export const openCount = (r: R, uid: number) => ownFus(r, uid).filter((f) => ["pending", "active", "paused"].includes(f.status)).length;
export async function llmAllowed(r: R, uid: number) {
  if (uid === DB(r).owner) return true;
  const t = now();
  const h = ((await r.S.getState<number[]>(`llm:${uid}`)) || []).filter((x) => t - x < 3600);
  if (h.length >= LLM_PER_HOUR) { await r.S.setState(`llm:${uid}`, h); return false; }
  h.push(t); await r.S.setState(`llm:${uid}`, h); return true;
}
export const cname = (u: any) => String(u.first_name || u.username || "رفیق").slice(0, 30);
export const fullName = (u: any) => [u.first_name, u.last_name].filter(Boolean).join(" ");
export function spreadPerDay(n: number, start = 9 * 60, end = 22 * 60): string[] {
  n = Math.max(1, Math.min(Math.trunc(n), 14));
  if (n === 1) return ["12:00"];
  const step = (end - start) / (n - 1);
  return Array.from({ length: n }, (_, i) => { const m = Math.trunc(pyRound(start + i * step)); return `${pad2(Math.floor(m / 60))}:${pad2(m % 60)}`; });
}
export function clampSchedule(r: R, s: any, uid: number): [any, string] {
  if (uid === DB(r).owner || !s) return [s, ""];
  if (s.type === "times" && s.times.length > MAX_PER_DAY)
    return [{ type: "times", times: spreadPerDay(MAX_PER_DAY) }, `\n(سقف روزی ${fa(MAX_PER_DAY)} پیامه، همون ${fa(MAX_PER_DAY)} بار گذاشتم.)`];
  if (s.type === "interval" && s.hours < 24 / MAX_PER_DAY)
    return [{ type: "interval", hours: 24 / MAX_PER_DAY }, `\n(سقف روزی ${fa(MAX_PER_DAY)} پیامه، فاصله رو کردم ${fa(24 / MAX_PER_DAY)} ساعت.)`];
  return [s, ""];
}

// ---------------- schedule ----------------
export function parseSchedule(text: string): any {
  const t = norm(text);
  const times = [...t.matchAll(/(\d{1,2})[:٫.](\d{2})/g)];
  if (times.length) {
    const out = [...new Set(times.filter(([, h, m]) => Number(h) < 24 && Number(m) < 60).map(([, h, m]) => `${pad2(Number(h))}:${pad2(Number(m))}`))].sort();
    return out.length ? { type: "times", times: out } : null;
  }
  const m = /(\d+(?:\.\d+)?)\s*(ساعت|hour|h|روز|day|d)/i.exec(t);
  if (m) {
    const n = parseFloat(m[1]), unit = m[2].toLowerCase();
    const hours = ["روز", "day", "d"].includes(unit) ? n * 24 : n;
    return { type: "interval", hours: Math.max(1.0, hours) };
  }
  if (/(روزی|هر روز|daily)/.test(t)) return { type: "interval", hours: 24.0 };
  return null;
}
export function schedText(s: any) {
  if (s.type === "times") return "هر روز ساعت " + s.times.map((x: string) => fa(x)).join("، ") + " (تهران)";
  const h = Number(s.hours);
  return `هر ${fa(h % 24 === 0 ? Math.trunc(h / 24) : h)} ${h % 24 === 0 ? "روز" : "ساعت"}`;
}
export function computeNext(fu: FU, nowTs?: number) {
  const n = Math.max(nowTs || now(), fu.skip_until || 0);
  const last = fu.last_sent || 0;
  const s = fu.schedule;
  let base: number | null;
  if (s.type === "interval") base = last ? last + s.hours * 3600 : n + 60;
  else {
    base = null;
    const p = teh(n);
    for (let dd = 0; dd < 3 && !base; dd++) {
      const day = new Date(Date.UTC(p.y, p.mo - 1, p.d + dd));
      for (const hm of s.times) {
        const [h, m] = hm.split(":").map(Number);
        const cand = tehTs(day.getUTCFullYear(), day.getUTCMonth() + 1, day.getUTCDate(), h, m);
        if (cand > n && cand >= last + MIN_GAP) { base = cand; break; }
      }
    }
    base = base || n + 86400;
  }
  return Math.max(base!, last ? last + MIN_GAP : base!);
}

// ---------------- LLM (FREE MODELS ONLY) ----------------
const MODELS = ["baidu/ernie-5.5-flash-preview:free", "google/gemma-4-31b-it:free",
  "nvidia/nemotron-3-ultra-550b-a55b:free", "google/gemma-4-26b-a4b-it:free"].filter((m) => m.endsWith(":free"));
const FREE_ONLY = { provider: { max_price: { prompt: 0, completion: 0, request: 0, image: 0 } } };
function freeModel(m: string) { if (!String(m).endsWith(":free")) { log("BLOCKED non-free model id", m); return false; } return true; }
function freeResponse(j: any, model: string) {
  const served = String(j.model || model); const cost = (j.usage || {}).cost || 0;
  if (!served.endsWith(":free") || cost) { log("DISCARDED non-free response", served, cost); return false; }
  return true;
}
export function clean(txt: string | null | undefined) {
  let t = (txt || "").replace(/<think>[\s\S]*?<\/think>/g, "").trim();
  t = stripChars(t, '"«»“”').trim();
  t = t.replace(/[\u00C0-\u024F\u0400-\u04FF\u4e00-\u9fff]+/g, "").replace(/أ/g, "ا");
  t = stripChars(t.replace(/\*\*/g, "").replace(/__/g, "").trim(), '"«»“”').trim();
  return t.slice(0, 900);
}
async function orCall(r: R, model: string, body: any, timeoutMs: number) {
  r.sub++;
  const resp = await fetch("https://openrouter.ai/api/v1/chat/completions", {
    method: "POST", signal: AbortSignal.timeout(timeoutMs),
    headers: { Authorization: `Bearer ${r.orKey}`, "Content-Type": "application/json", "HTTP-Referer": "https://t.me/naser_paygir_bot", "X-Title": "Paygir Bot" },
    body: JSON.stringify({ model, ...body, reasoning: { effort: "low", exclude: true }, ...FREE_ONLY }),
  });
  const j: any = await resp.json().catch(() => ({}));
  return { status: resp.status, j };
}
export async function llm(r: R, messages: any[], maxTokens = 500): Promise<[string | null, string | null]> {
  for (const model of MODELS) {
    if (!freeModel(model)) continue;
    if (r.sub >= SUB_BUDGET - 3) break;
    try {
      const { status, j } = await orCall(r, model, { messages, max_tokens: maxTokens + 1200, temperature: 1.0 }, 60000);
      if (status === 200 && j.choices && freeResponse(j, model)) {
        const txt = clean(j.choices[0].message?.content);
        if (txt && /[\u0600-\u06FF]/.test(txt)) return [txt, model];
      }
      log("model failed", model, status, String(j?.error?.message || "no-text/empty").slice(0, 120));
    } catch (e) { log("model error", model, String(e)); }
  }
  return [null, null];
}
export function extractJson(txt: string | null | undefined): any {
  if (!txt) return null;
  txt = txt.replace(/<think>[\s\S]*?<\/think>/g, "");
  const m = /```(?:json)?\s*(\{[\s\S]*?\})\s*```/.exec(txt);
  let cand = m ? m[1] : null;
  if (!cand) { const s = txt.indexOf("{"), e = txt.lastIndexOf("}"); if (s === -1 || e <= s) return null; cand = txt.slice(s, e + 1); }
  try { return JSON.parse(cand); } catch { try { return JSON.parse(cand.replace(/,\s*([}\]])/g, "$1")); } catch { return null; } }
}
export async function llmJson(r: R, system: string, user: string, maxTokens = 700): Promise<[any, string | null]> {
  const msgs = [{ role: "system", content: system }, { role: "user", content: user }];
  for (const model of [...MODELS, ...MODELS.slice(0, 2)]) {
    if (!freeModel(model)) continue;
    if (r.sub >= SUB_BUDGET - 6) break;
    try {
      const { status, j } = await orCall(r, model, { messages: msgs, max_tokens: maxTokens + 1500, temperature: 0.5 }, 90000);
      if (status === 200 && j.choices && freeResponse(j, model)) {
        const d = extractJson(j.choices[0].message?.content);
        if (d && typeof d === "object" && !Array.isArray(d)) return [d, model];
      }
      log("json model failed", model, status, String(j?.error?.message || "no-json/empty").slice(0, 120));
      if (status === 429) await sleep(1500);
    } catch (e) { log("json model error", model, String(e)); }
  }
  return [null, null];
}

// ---------------- generation ----------------
export const levelFor = (n: number) => LEVELS[Math.min(Math.floor(n / 2), LEVELS.length - 1)];
export const subj = (fu: FU) => fu.subject + (T(fu.amount) ? ` (${fu.amount})` : "");
export async function genFollowup(r: R, fu: FU, voice = false): Promise<[string, string]> {
  const n = fu.sent_count || 0;
  const prev = (fu.history || []).slice(-5);
  let user = `اسم طرف: ${fu.name} (فقط با همین اسم صداش کن؛ هیچ‌وقت یوزرنیم یا آیدی یا @ ننویس)\nموضوع: ${subj(fu)}\n`
    + (T(fu.notes) ? "توضیحات/زمینه از طرف صاحب‌کار (ازشون استفاده کن): " + fu.notes.slice(-5).join(" | ") + "\n" : "")
    + `شماره‌ی این پیام پیگیری: ${n + 1}\n`
    + `سطح پیگیری: ${levelFor(n)}\n`;
  if (prev.length) user += "پیام‌های قبلی (اینا رو تکرار نکن):\n" + prev.map((p: string) => `- ${p}`).join("\n");
  if (voice) {
    user += `\nاین پیام قراره ویس (صوتی) بشه: حداکثر ${V.MAX_WORDS} کلمه، ۱-۲ جمله‌ی کوتاه و گفتاری، بدون ایموجی و علامت عجیب، مثل اینکه داری با صدای لوتی پشت تلفن حرف می‌زنی.`;
    if (DB(r).voice_style !== "orig") user += "\n" + SPOKEN_HINT;
  }
  await ensureGender(r, fu);
  user += "\n" + genderHint(fu.gender, fu.self ? "خودش" : "طرف");
  const sysm = fu.self ? SELF_SYSTEM : SYSTEM.split("حامد").join(fu.creator_name || "رفیقم");
  if (fu.self) user = user.replace("اسم طرف:", "اسم خودش:").replace("موضوع:", "کار/هدفش:") + (fu.recurring ? "\n(کار تکراری/عادت روزانه)" : "");
  let [txt, model] = await llm(r, [{ role: "system", content: sysm }, { role: "user", content: user }]);
  if (!txt) { txt = choice(FALLBACK).split("{name}").join(fu.name).split("{subject}").join(subj(fu)); model = "template"; }
  return [genderFix(scrubIds(txt, fu), fu.gender), model!];
}
export async function genThanks(r: R, fu: FU) {
  await ensureGender(r, fu);
  const [txt] = await llm(r, [{ role: "system", content: "به فارسی محاوره‌ای و لوتی‌منش، یه پیام تشکر کوتاه (۱-۲ جمله) و بامزه بنویس چون طرف بدهی/خواسته‌اش رو انجام داده. فقط متن پیام." },
    { role: "user", content: `اسم: ${fu.name}\nموضوع: ${subj(fu)}\n${genderHint(fu.gender)}` }], 200);
  return genderFix(txt || `${fu.name} جان دمت گرم! بابت ${subj(fu)} مرسی، معرفتت رو نشون دادی 🌹`, fu.gender);
}

// ---------------- names ----------------
export const nz = (s: any) => String(s ?? "").toLowerCase().replace(/ي/g, "ی").replace(/ك/g, "ک").replace(/\u200c/g, " ").replace(/ـ/g, "").replace(/\s+/g, " ").trim().replace(/^@+/, "");
const NAME_RANK: Record<string, number> = { given: 3, telegram: 2, username: 1 };
const rank = (s: any) => NAME_RANK[s] || 0;
export const hasFa = (x: any) => /[\u0600-\u06FF]/.test(x || "");
const mkeys = (uid: any, uname: any, creator?: any) => {
  const ks = [...(uid ? [`u:${uid}`] : []), ...(uname ? [`@${uname}`] : [])];
  return creator ? ks.map((k) => `c${creator}:${k}`) : ks;
};
export function memGet(r: R, uid?: any, uname?: any, creator?: any) {
  for (const k of [...(creator ? mkeys(uid, uname, creator) : []), ...mkeys(uid, uname)]) {
    const v = DB(r).name_mem[k];
    if (v && (k.startsWith("c") || v.source !== "given")) return v;
  }
  return null;
}
export function memPut(r: R, uid: any, uname: any, name: string, source: string | null, creator?: any) {
  for (const k of mkeys(uid, uname, source === "given" ? creator : null)) {
    const old = DB(r).name_mem[k];
    if (!old || rank(source) >= rank(old.source)) DB(r).name_mem[k] = { name, source };
  }
}
export async function toFaName(r: R, raw: any): Promise<string | null> {
  raw = String(raw || "").trim().replace(/^@+/, "");
  if (!raw) return null;
  if (hasFa(raw)) return raw.replace(/[^\u0600-\u06FF\u200c ]/g, "").trim().slice(0, 30) || null;
  const key = raw.toLowerCase();
  if (key in DB(r).translit) return DB(r).translit[key];
  const [txt] = await llm(r, [{ role: "system", content: "تو یه مترجم اسم هستی. یه اسم یا یوزرنیم لاتین بهت می‌دن؛ اسم کوچیکِ فارسیِ درستش رو بنویس (مثلاً Reza→رضا، Mohammad→محمد، mmd_r→محمد، ali.k→علی، Sara→سارا، Hamed→حامد). اگه اسم آدم نیست یا معلوم نیست، فقط بنویس: رفیق. فقط خودِ اسم، بدون هیچ توضیح." },
    { role: "user", content: raw }], 30);
  let name = (txt || "").replace(/[^\u0600-\u06FF\u200c ]/g, "").trim();
  if (!name || name.length > 20 || words(name).length > 2) name = "رفیق";
  DB(r).translit[key] = name; await r.S.save();
  return name;
}
export function tgFirst(r: R, uid: any) {
  if (!uid) return null;
  if (String(uid) in DB(r).tg_names) return DB(r).tg_names[String(uid)];
  for (const g of Object.values(DB(r).groups)) { const m = g.members[String(uid)]; if (m && m.first) return m.first; }
  return null;
}
export async function resolveDisplay(r: R, uid: any, uname: any, given: any, creator?: any): Promise<[string, string | null]> {
  if (given && !String(given).trim().startsWith("@") && nz(given) !== nz(uname || "")) {
    const n = await toFaName(r, given);
    if (n && n !== "رفیق") { memPut(r, uid, uname, n, "given", creator); return [n, "given"]; }
  }
  const m = memGet(r, uid, uname, creator);
  if (m && m.source === "given") return [m.name, "given"];
  const first = tgFirst(r, uid);
  if (first) { const n = await toFaName(r, first); if (n) { memPut(r, uid, uname, n, "telegram"); return [n, "telegram"]; } }
  if (m) return [m.name, m.source];
  if (uname) {
    const n = (await toFaName(r, String(uname).split(/[\p{Nd}_.\-]+/u)[0] || uname))!;
    memPut(r, uid, uname, n, "username"); return [n, "username"];
  }
  return [given || "رفیق", given ? "given" : null];
}
export async function refreshName(r: R, fu: FU) {
  if (fu.self) {
    if (!hasFa(fu.name)) { const n = await toFaName(r, fu.name); if (n && n !== "رفیق") fu.name = n; }
    return;
  }
  if (rank(fu.name_source) >= 3) return;
  const [n, src] = await resolveDisplay(r, fu.target_user_id, fu.target_username, null, fu.creator_id);
  if (n && rank(src) > rank(fu.name_source)) { fu.name = n; fu.name_source = src; if (fu.gender_source !== "given") { fu.gender = null; await ensureGender(r, fu); } }
}

// ---------------- gender ----------------
export async function inferGender(r: R, name: any): Promise<Gender> {
  const g = guessGender(name);
  if (g) return g;
  const key = "g:" + String(name || "").trim().toLowerCase();
  if (key === "g:") return "unknown";
  const cached = normGender(DB(r).translit[key]);
  if (cached) return cached;
  const [txt] = await llm(r, [{ role: "system", content: "تو یه دستیار اسم‌شناسی. یه اسم (فارسی یا لاتین) بهت می‌دن؛ بگو معمولاً اسم پسره یا دختر. اگه مطمئن نیستی یا اسم آدم نیست، نامعلوم. فقط یکی از این کلمه‌ها رو بنویس: پسر / دختر / نامعلوم" },
    { role: "user", content: String(name) }], 20);
  const t = txt || "";
  const out: Gender = /دختر|زن|خانم/.test(t) ? "female" : /پسر|مرد|آقا/.test(t) ? "male" : "unknown";
  if (txt) DB(r).translit[key] = out;
  return out;
}
export async function ensureGender(r: R, fu: FU) {
  if (fu.gender) return fu.gender;
  fu.gender = await inferGender(r, fu.name); fu.gender_source = fu.gender_source || "inferred";
  return fu.gender;
}
export async function userGender(r: R, u: any): Promise<Gender> {
  if (!u) return "unknown";
  const given = Object.values(DB(r).followups).find((f) => f.target_user_id === u.id && f.gender_source === "given" && f.gender);
  if (given) return given.gender;
  const own = normGender(DB(r).translit["gu:" + u.id]);
  if (own) return own;
  return inferGender(r, u.first_name || u.username || "");
}
export { genderFix, genderHint, normGender };
export function scrubIds(txt: string, fu: FU) {
  let t = (txt || "").replace(/@[\p{L}\p{N}_]+/gu, () => fu.name);
  const un = fu.target_username;
  if (un) t = t.replace(new RegExp(escRe(un), "gi"), () => fu.name);
  if (fu.target_user_id) t = t.split(String(fu.target_user_id)).join("");
  return t.replace(/\s{2,}/g, " ").trim();
}
export function markStarted(r: R, uid: number) { if (!DB(r).started.includes(uid)) DB(r).started.push(uid); }
export function rememberUser(r: R, u: any, chatId: number) { if (u.username) DB(r).users[u.username.toLowerCase()] = chatId; }
export function registerMember(r: R, chat: any, u: any) {
  if (u && !u.is_bot && u.first_name) DB(r).tg_names[String(u.id)] = u.first_name;
  if (!chat || !isGroup(chat) || !u || u.is_bot) return;
  const g = (DB(r).groups[String(chat.id)] ||= { title: chat.title ?? null, members: {} });
  g.title = chat.title ?? null;
  const old: any = g.members[String(u.id)] || {};
  const nw: Member = { first: u.first_name || "", last: u.last_name || "", username: (u.username || "").toLowerCase(), seen: Math.floor(now()) };
  if (old.first !== nw.first || old.last !== nw.last || old.username !== nw.username || now() - (old.seen || 0) > 3600) g.members[String(u.id)] = nw;
}
export const members = (r: R, chatId: any): Record<string, Member> => DB(r).groups[String(chatId)]?.members || {};
export const mname = (m: Member) => (m.first + " " + m.last).trim() || m.username;
export function codeMatch(r: R, chatId: any, name: string): number[] {
  const q = nz(name), out: number[] = [];
  if (!q) return out;
  for (const [uid, m] of Object.entries(members(r, chatId))) {
    const fields = [nz(m.first), nz(m.last), nz(mname(m)), nz(m.username)];
    if (fields.some((f) => f && (f === q || f.split(" ").includes(q) || (q.length >= 3 && (f.includes(q) || q.includes(f)))))) out.push(Number(uid));
  }
  return out;
}
export function mentionHtml(fu: FU) {
  if (fu.mode === "group") {
    if (fu.target_user_id) return `<a href="tg://user?id=${fu.target_user_id}">${esc(fu.name)}</a> `;
    if (fu.target_username) return `@${esc(fu.target_username)} `;
  }
  return "";
}

// ---------------- sending ----------------
export async function sendVoiceOrText(r: R, chatId: number, txt: string, captionHtml?: string | null, replyTo?: number | null, forceVoice = false): Promise<[any, boolean]> {
  if (forceVoice && r.sub < SUB_BUDGET - 4) {
    try {
      r.sub++;
      const v = await V.synth(txt, DB(r).voice_style);
      if (v) {
        try {
          const m = await tgVoice(r, { chat_id: chatId, caption: captionHtml || undefined, parse_mode: captionHtml ? "HTML" : undefined, duration: v.duration || undefined, ...(replyTo ? { reply_parameters: { message_id: replyTo, allow_sending_without_reply: true } } : {}) }, v.audio);
          log("voice sent", v.engine, words(v.spoken).length);
          return [m, true];
        } catch (e) { log("send_voice failed", String(e)); }
      }
    } catch (e) { log("tts failed", String(e)); }
  }
  const m = await tg(r, "sendMessage", { chat_id: chatId, text: ((captionHtml || "") + esc(txt)).slice(0, 4096), parse_mode: "HTML", ...replyParams(replyTo) });
  return [m, false];
}
export async function sendToTarget(r: R, fu: FU, txt: string, voice = false) {
  const [m] = await sendVoiceOrText(r, fu.target_chat_id, txt, mentionHtml(fu) || null, null, voice);
  fu.bot_msg_ids = [...(fu.bot_msg_ids || []), m.message_id].slice(-30);
  return m;
}
export async function notify(r: R, uid: any, text: string, fu?: FU | null, kw: any = {}) {
  if (!uid) return;
  if (fu && fu.self) return;
  try { await tg(r, "sendMessage", { chat_id: uid, text: text.slice(0, 4096), ...kw }); } catch (e) { log("notify failed", uid, String(e)); }
}
export const notifyOwner = (r: R, text: string, kw: any = {}) => notify(r, DB(r).owner, text, null, kw);
export async function firstCreationNotice(r: R, u: any) {
  if (u.id === DB(r).owner || ownFus(r, u.id).length) return;
  const who = esc(fullName(u)) + (u.username ? ` @${esc(u.username)}` : "");
  await notifyOwner(r, `🆕 کاربر جدید اولین پیگیریش رو ساخت: ${who} (id: <code>${u.id}</code>)\nبرای بستنش: /ban ${u.id}`, { parse_mode: "HTML" });
}
export function wantVoice(r: R, fu?: FU | null) {
  const mode = (fu || {}).voice || "auto";
  if (mode === "always") return true;
  if (mode === "never") return false;
  return Math.random() < Number(DB(r).voice_prob ?? 0.28);
}
export const deepLink = (r: R, fu: FU) => `https://t.me/${r.botUsername}?start=${fu.code}`;
export function fuLine(fu: FU, pub = false) {
  let nxt = "";
  if (fu.status === "active" && fu.next_due) { const p = teh(fu.next_due); nxt = "\nپیام بعدی: " + fa(`${pad2(p.mo)}/${pad2(p.d)} ${pad2(p.h)}:${pad2(p.mi)}`); }
  const mx = fu.max_count ? ` از ${fa(fu.max_count)}` : "";
  const tag = fu.target_username ? ` (@${esc(fu.target_username)})` : "";
  const nts = (T(fu.notes) && !pub) ? "\n📝 " + esc(fu.notes.slice(-3).join(" | ")) : "";
  return `<b>#${fa(fu.id)}</b> ${esc(fu.name)}${tag} — ${esc(subj(fu))}${nts}\n`
    + `${(STATUS as any)[fu.status]} | ${schedText(fu.schedule)} | ارسال‌شده: ${fa(fu.sent_count || 0)}${mx}${nxt}`;
}
export function listText(r: R, fus: FU[], chat: any) {
  if (chat && chat.type !== "private") return scoped(fus, chat).map((f) => fuLine(f, true)).join("\n\n");
  const groups = new Map<string, FU[]>();
  for (const f of fus) { const k = whereLabel(r, f); if (!groups.has(k)) groups.set(k, []); groups.get(k)!.push(f); }
  return [...groups.entries()].map(([k, v]) => `<b>${esc(k)}</b>\n` + v.map((f) => fuLine(f)).join("\n\n")).join("\n\n");
}
export function activate(fu: FU, chatId: number) { fu.target_chat_id = chatId; fu.status = "active"; fu.next_due = computeNext(fu); }
export async function newFu(r: R, kw: Record<string, any>): Promise<FU> {
  const fid = await r.S.nextId();
  const fu: FU = { id: fid, code: "f" + token(9).replace(/-/g, "x").replace(/_/g, "y"),
    status: "pending", target_chat_id: null, target_username: null, target_user_id: null,
    mode: "private", sent_count: 0, history: [], convo: [], last_sent: null,
    next_due: null, created: now(), amount: null, max_count: null, ...kw };
  DB(r).followups[String(fid)] = fu;
  return fu;
}
export { V, norm, fa, esc, T, now, words, choice, sleep, token, teh, tehTs, pad2 };
