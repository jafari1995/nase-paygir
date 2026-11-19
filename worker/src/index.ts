// «ناصر» — Telegram follow-up bot on Cloudflare Workers (webhook + cron + D1).
import { Store } from "./store";
import { Env, mkR, isGroup, R } from "./core";
import * as H from "./handlers";
import { now } from "./util";

type E = Env & { BOT_USERNAME?: string };

function safeEq(a: string, b: string) {
  if (!a || !b || a.length !== b.length) return false;
  let x = 0; for (let i = 0; i < a.length; i++) x |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return x === 0;
}

async function light(env: E, msg: any): Promise<boolean> {
  // Group chatter that doesn't address Naser: only keep the member registry fresh (no full load).
  const chat = msg.chat, text: string = msg.text || msg.caption || "";
  if (!isGroup(chat) || msg.new_chat_members || msg.migrate_to_chat_id) return false;
  if (text.startsWith("/")) return false;
  const bu = (env.BOT_USERNAME || "").toLowerCase(), botId = Number(String(env.TELEGRAM_BOT_TOKEN).split(":")[0]);
  const rt = msg.reply_to_message;
  if (text && (/ناصر/.test(text) || (bu && text.toLowerCase().includes("@" + bu)) || (rt && rt.from && rt.from.id === botId))) return false;
  const db = env.DB, st: D1PreparedStatement[] = [];
  const t = Math.floor(now());
  st.push(db.prepare("INSERT INTO groups (chat_id, title) VALUES (?, ?) ON CONFLICT(chat_id) DO UPDATE SET title = excluded.title WHERE groups.title IS NOT excluded.title").bind(chat.id, chat.title ?? null));
  for (const u of [msg.from, rt?.from]) {
    if (!u || u.is_bot) continue;
    if (u.first_name) st.push(db.prepare("INSERT INTO tg_names (uid, first) VALUES (?, ?) ON CONFLICT(uid) DO UPDATE SET first = excluded.first WHERE tg_names.first IS NOT excluded.first").bind(u.id, u.first_name));
    st.push(db.prepare("INSERT INTO members (chat_id, uid, first, last, username, seen) VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT(chat_id, uid) DO UPDATE SET first=excluded.first, last=excluded.last, username=excluded.username, seen=excluded.seen WHERE members.first IS NOT excluded.first OR members.last IS NOT excluded.last OR members.username IS NOT excluded.username OR excluded.seen - members.seen > 3600")
      .bind(chat.id, u.id, u.first_name || "", u.last_name || "", (u.username || "").toLowerCase(), t));
  }
  await db.batch(st);
  return true;
}

function parseCommand(msg: any, botUsername: string): { cmd: string; args: string[] } | null {
  const text: string = msg.text || "";
  const e = (msg.entities || [])[0];
  if (!e || e.type !== "bot_command" || e.offset !== 0) return null;
  const raw = text.slice(1, e.length);
  const [cmd, at] = raw.split("@");
  if (at && at.toLowerCase() !== (botUsername || "").toLowerCase()) return { cmd: "", args: [] }; // addressed to another bot
  return { cmd: cmd.toLowerCase(), args: text.slice(e.length).trim().split(/\s+/).filter(Boolean) };
}

async function handleUpdate(env: E, upd: any) {
  const msg = upd.message;
  if (msg && msg.from && (await light(env, msg))) return;
  if (!msg && !upd.callback_query && !upd.my_chat_member) return;   // edited messages etc. are ignored
  const S = await Store.load(env.DB);
  if (env.BOT_USERNAME && !S.d.bot_username) S.d.bot_username = env.BOT_USERNAME;
  const r: R = mkR(env, S);
  if (!r.botUsername) r.botUsername = env.BOT_USERNAME || "";
  try {
    if (upd.callback_query) {
      if (/^(thx|nothx|cdone|nodone):/.test(upd.callback_query.data || "")) await H.onCallback(r, upd.callback_query);
      return;
    }
    if (upd.my_chat_member) { await H.onMyMember(r, upd.my_chat_member); return; }
    if (!msg.from) return;
    const c: H.Ctx = { r, update: upd, msg, chat: msg.chat, user: msg.from };
    c.ug = await (await import("./core")).userGender(r, msg.from);
    if (msg.new_chat_members) { H.onMembers(c); return; }
    if (msg.migrate_to_chat_id) { await H.onMigrate(r, msg); return; }
    const pc = parseCommand(msg, r.botUsername);
    if (pc) {
      if (!pc.cmd) return;
      if (pc.cmd === "start") { await H.start(c, pc.args); return; }
      const w = await H.wizardState(c);
      if (w) { if (pc.cmd === "cancel") { await H.wizardCancel(c); return; } }
      else if (pc.cmd === "new") { await H.wizardNew(c); return; }
      const fn = H.commands[pc.cmd];
      if (fn) await fn(c, pc.args);
      return;
    }
    if (msg.text) {
      const w = await H.wizardState(c);
      if (w) { await H.wizardStep(c, w); return; }
    }
    if (msg.text || msg.caption) await H.onText(c);
  } finally {
    await S.save();
  }
}

async function tick(env: E) {
  const db = env.DB, t = now();
  const lock = await db.prepare("UPDATE kv SET v = ? WHERE k = 'tick_lock' AND CAST(v AS REAL) < ?").bind(String(t + 240), t).run();
  if (!lock.meta.changes) return;
  try {
    if (new Date().getUTCMinutes() === 0) await db.prepare("DELETE FROM seen_updates WHERE ts < ?").bind(t - 3 * 86400).run();
    const due = await db.prepare("SELECT id FROM followups WHERE status = 'active' AND target_chat_id IS NOT NULL AND (next_due IS NULL OR next_due <= ?) ORDER BY id").bind(t).all();
    if (!due.results?.length) return;
    const S = await Store.load(db);
    const r = mkR(env, S); if (!r.botUsername) r.botUsername = env.BOT_USERNAME || "";
    for (const row of due.results as any[]) {
      if (r.sub > 30) break;   // stay inside the 50-subrequest budget; the rest go next minute
      const fu = S.d.followups[String(row.id)];
      if (!fu) continue;
      try { await H.tickOne(r, fu); } catch (e) { console.log("tick error", fu.id, String(e)); }
    }
    await S.save();
  } finally {
    await db.prepare("UPDATE kv SET v = '0' WHERE k = 'tick_lock'").run();
  }
}

/** Webhook secret: WEBHOOK_SECRET if set, else derived from the bot token (sha256("naser-webhook:"+token), hex, 48 chars). */
async function webhookSecret(env: E): Promise<string> {
  if (env.WEBHOOK_SECRET) return env.WEBHOOK_SECRET;
  if (!env.TELEGRAM_BOT_TOKEN) return "";
  const h = await crypto.subtle.digest("SHA-256", new TextEncoder().encode("naser-webhook:" + env.TELEGRAM_BOT_TOKEN));
  return [...new Uint8Array(h)].map((b) => b.toString(16).padStart(2, "0")).join("").slice(0, 48);
}

export default {
  async fetch(req: Request, env: E, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(req.url);
    if (req.method === "GET" && url.pathname === "/selftest/tts") {
      // Owner-only diagnostics: synthesize a sample (nothing is sent to Telegram).
      if (!safeEq(req.headers.get("X-Selftest-Token") || "", await webhookSecret(env))) return new Response("forbidden", { status: 403 });
      const { synth } = await import("./tts");
      const kv = await env.DB.prepare("SELECT v FROM kv WHERE k = 'voice_style'").first<{ v: string }>();
      const v = await synth(url.searchParams.get("t") || "رضا داش، نوکرتم… ولی اون پول رو کی میدی؟ مرامت رو نشون بده دیگه!", kv?.v || "AB");
      if (!v) return new Response("tts failed", { status: 502 });
      return new Response(v.audio, { headers: { "content-type": "audio/mpeg", "x-engine": v.engine, "x-duration": String(v.duration) } });
    }
    if (req.method === "GET") return new Response(url.pathname === "/" ? "ناصر سر کاره 😎" : "not found", { status: url.pathname === "/" ? 200 : 404, headers: { "content-type": "text/plain; charset=utf-8" } });
    if (req.method !== "POST" || url.pathname !== "/telegram") return new Response("not found", { status: 404 });
    if (!env.TELEGRAM_BOT_TOKEN) return new Response("not configured", { status: 503 });
    if (!safeEq(req.headers.get("X-Telegram-Bot-Api-Secret-Token") || "", await webhookSecret(env))) return new Response("forbidden", { status: 403 });
    let upd: any;
    try { upd = await req.json(); } catch { return new Response("bad request", { status: 400 }); }
    if (typeof upd.update_id === "number") {
      const ins = await env.DB.prepare("INSERT OR IGNORE INTO seen_updates (update_id, ts) VALUES (?, ?)").bind(upd.update_id, now()).run();
      if (!ins.meta.changes) return new Response("dup");
    }
    try { await handleUpdate(env, upd); } catch (e) { console.log("update error", String((e as Error)?.stack || e)); }
    return new Response("ok");
  },
  async scheduled(_ev: ScheduledController, env: E, ctx: ExecutionContext) {
    if (!env.TELEGRAM_BOT_TOKEN || !env.OPENROUTER_API_KEY) return;   // secrets not set yet
    try { await tick(env); } catch (e) { console.log("tick failed", String(e)); }
  },
};
