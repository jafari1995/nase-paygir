import { Miniflare } from "miniflare";
import fs from "fs";
import crypto from "crypto";
const SECRET = crypto.createHash("sha256").update("naser-webhook:9081523440:FAKE_TOKEN_FOR_TEST").digest("hex").slice(0, 48);
const calls = []; let mid = 1000;
const mf = new Miniflare({
  modules: true, scriptPath: "dist/worker.js", compatibilityDate: "2025-09-01",
  d1Databases: { DB: "test-db" }, d1Persist: false,
  bindings: { TELEGRAM_BOT_TOKEN: "9081523440:FAKE_TOKEN_FOR_TEST", OPENROUTER_API_KEY: process.env.OPENROUTER_API_KEY, WEBHOOK_SECRET: "", BOT_USERNAME: "naser_paygir_bot" },
  outboundService: async (req) => {
    const u = new URL(req.url);
    if (u.hostname === "api.telegram.org") {
      const method = u.pathname.split("/").pop();
      let p = {};
      if ((req.headers.get("content-type") || "").includes("multipart")) {
        const fd = await req.formData(); for (const [k, v] of fd) { if (typeof v === "string") p[k] = v; else { const b = Buffer.from(await v.arrayBuffer()); fs.writeFileSync(`/tmp/mf_voice_${mid}.mp3`, b); p[k] = `<${b.length} bytes>`; } }
      } else p = await req.json();
      calls.push({ method, ...p });
      const m = { message_id: ++mid, chat: { id: Number(p.chat_id) }, date: 0, text: p.text };
      if (method === "sendVoice") m.voice = { duration: Number(p.duration) || 1 };
      return new Response(JSON.stringify({ ok: true, result: ["sendMessage", "sendVoice", "editMessageText"].includes(method) ? m : true }), { headers: { "content-type": "application/json" } });
    }
    try { const body = ['GET','HEAD'].includes(req.method) ? undefined : await req.arrayBuffer(); return await fetch(req.url, { method: req.method, headers: req.headers, body }); } catch (e) { console.log('outbound error', req.url, String(e)); return new Response('outbound error', { status: 502 }); }
  },
});
const db = await mf.getD1Database("DB");
const exec = async (sql) => { for (const s of sql.split(/;\s*\n/).map((x) => x.trim()).filter(Boolean)) await db.prepare(s).run(); };
await exec(fs.readFileSync("/workspace/followup-bot/worker/schema.sql", "utf8").replace(/--.*\n/g, "\n"));
await exec(fs.readFileSync("/workspace/followup-bot/worker/.migrate/test.sql", "utf8"));
let uid = 1;
const OWNER = { id: 507134355, is_bot: false, first_name: "Hamed", username: "hamedj" };
export async function send(from, chat, text, extra = {}) {
  const upd = { update_id: uid++, message: { message_id: 5000 + uid, from, chat, date: 0, text, ...extra } };
  if (text && text.startsWith("/")) upd.message.entities = [{ type: "bot_command", offset: 0, length: text.split(" ")[0].length }];
  const before = calls.length;
  const res = await mf.dispatchFetch("https://naser.test/telegram", { method: "POST", headers: { "X-Telegram-Bot-Api-Secret-Token": SECRET, "content-type": "application/json" }, body: JSON.stringify(upd) });
  await res.text();
  return calls.slice(before);
}
export async function cb(from, chat, data, message_id) {
  const before = calls.length;
  await (await mf.dispatchFetch("https://naser.test/telegram", { method: "POST", headers: { "X-Telegram-Bot-Api-Secret-Token": SECRET }, body: JSON.stringify({ update_id: uid++, callback_query: { id: "q" + uid, from, data, message: { message_id, chat } } }) })).text();
  return calls.slice(before);
}
export async function tick() { const before = calls.length; await db.prepare("UPDATE kv SET v='0' WHERE k='tick_lock'").run(); const r = await mf.getWorker(); await r.scheduled({ cron: "* * * * *" }); return calls.slice(before); }
export { mf, db, calls, OWNER };
