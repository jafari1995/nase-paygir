import { FU } from "./store";
import { OWNER_SYS, TARGET_SYS, OTHER_SYS, HELP, STATUS } from "./prompts";
import * as C from "./core";
import { R, DB, tg, replyText, isGroup, kb, MAX_ACTIVE, MAX_PER_DAY, MIN_GAP } from "./core";
import { norm, fa, esc, T, now, words, teh, tehTs, pad2 } from "./util";

export type Ctx = { r: R; update: any; msg: any; chat: any; user: any; ug?: string };
const log = (...a: any[]) => console.log(...a);
const SELFDONE_RE = /(انجام\s*دادم|انجامش\s*دادم|تمومش\s*کردم|تموم\s*شد|^\s*(ناصر\s*)?\S+\s*(کردم|رفتم|خوندم|زدم)\s*[!.]*\s*$|\bdone\b)/;
export const STOP_RE = /(مزاحم|ولم کن|ول کن دیگه|دست از سرم|بسه دیگه|بس کن|پیام نده|خفه|بلاکت|^\/stop)/;
const VOICE_RE = /(با\s*ویس|ویس\s*(بده|بفرست|بگو)|صوتی|وویس)/;
const NOVOICE_RE = /(بدون\s*ویس|ویس\s*نده|ویس\s*نفرست|متنی)/;
const reply = (c: Ctx, text: string, kw: any = {}) => replyText(c.r, c.msg, C.genderFix(text, c.ug as any), kw);

// ---------- conversation memory (was ctx.chat_data) ----------
const hkey = (c: Ctx, uid: number) => `h:${c.chat.id}:${uid}`;
async function histGet(c: Ctx, uid: number): Promise<string[]> { return (await c.r.S.getState<string[]>(hkey(c, uid))) || []; }
async function histAdd(c: Ctx, role: string, text: string, uid: number) {
  const h = await histGet(c, uid); h.push(`${role}: ${text}`); await c.r.S.setState(hkey(c, uid), h.slice(-10));
}
async function ownerReply(c: Ctx, text: string, kw: any = {}) {
  text = C.genderFix(text, c.ug as any);
  await histAdd(c, "ناصر", text.replace(/<[^>]+>/g, "").slice(0, 300), c.user.id);
  return reply(c, text, { parse_mode: "HTML", link_preview_options: { is_disabled: true }, ...kw });
}

// ---------- /start & classic commands ----------
export async function start(c: Ctx, args: string[]) {
  const { r, user: u } = c; const chat = c.chat.id;
  C.rememberUser(r, u, chat);
  if (c.chat.type !== "private") return;
  C.markStarted(r, u.id);
  const code = args[0] || null;
  if (code) {
    const fu = Object.values(DB(r).followups).find((f) => f.code === code);
    if (fu && ["pending", "active", "paused"].includes(fu.status) && (fu.target_chat_id === null || fu.target_chat_id === undefined || fu.target_chat_id === chat)) {
      if (fu.self && u.id !== fu.creator_id) { await reply(c, "این لینک معتبر نیست یا منقضی شده."); return; }
      if (u.id === fu.creator_id && !fu.self) { await reply(c, "این لینک مال طرف مقابله، نه خودت 😄 بفرستش براش."); return; }
      const wasPending = fu.status === "pending";
      fu.target_chat_id = chat; fu.target_user_id = u.id; fu.mode = "private";
      if (u.first_name) DB(r).tg_names[String(u.id)] = u.first_name;
      if (u.username && !fu.target_username) fu.target_username = u.username.toLowerCase();
      await C.refreshName(r, fu);
      if (fu.gender_source !== "given") { fu.gender = null; await C.ensureGender(r, fu); }
      if (wasPending) C.activate(fu, chat);
      await r.S.save();
      const cn = fu.creator_name || "رفیقم";
      await replyText(r, c.msg, `سلام ${fu.name} 👋\nمن ناصرم، پیگیرِ ${cn}. یه سری پیام درباره‌ی «${C.subj(fu)}» برات می‌فرستم. هر جوابی بدی مستقیم به ${cn} می‌رسه.`);
      await C.notify(r, fu.creator_id, `🔔 طرفِ پیگیری #${fa(fu.id)} (${esc(fu.name)}) ربات رو استارت کرد` + `${u.username ? " (@" + esc(u.username) + ")" : ""}. پیگیری فعال شد.`, null, { parse_mode: "HTML" });
      return;
    }
    await reply(c, "این لینک معتبر نیست یا منقضی شده."); return;
  }
  if (DB(r).owner === null) {
    DB(r).owner = u.id; await r.S.save();
    await reply(c, "✅ تو الان صاحب این رباتی.\n\n" + HELP, { parse_mode: "HTML" }); return;
  }
  if (C.isBanned(r, u.id)) return;
  DB(r).names[String(u.id)] = C.cname(u);
  await reply(c, `سلام ${esc(C.cname(u))} 👋 من ناصرم، پیگیرِ لوتی. هر کی ازت طلب داره یا قولی داده و یادش رفته، بسپرش به من.\n\n` + HELP, { parse_mode: "HTML" });
}

async function need(c: Ctx, args: string[]): Promise<FU | null> {
  let fu: FU | null = null;
  if (args.length) { const n = norm(args[0]); if (/^[+-]?\d+$/.test(n)) fu = DB(c.r).followups[String(parseInt(n, 10))] || null; }
  if (fu && !C.canManage(c.r, c.user.id, fu)) fu = null;
  if (fu && !C.inScope(fu, c.chat)) fu = null;
  if (!fu) await reply(c, "شماره‌ی پیگیری رو درست بده، مثلاً: /pause 1  (لیست: /list)");
  return fu;
}
const thxKb = (fid: any, label = "🌹 بفرست پیام تشکر") => kb([[[label, `thx:${fid}`], ["نه", `nothx:${fid}`]]]);

export const commands: Record<string, (c: Ctx, args: string[]) => Promise<any>> = {
  async help(c) { if (C.isBanned(c.r, c.user.id)) return; await reply(c, HELP, { parse_mode: "HTML" }); },
  async list(c) {
    if (C.isBanned(c.r, c.user.id)) return;
    const fus = C.scoped(C.ownFus(c.r, c.user.id), c.chat);
    if (!fus.length && c.chat.type !== "private") { await reply(c, "تو این گروه پیگیری‌ای نداری. بقیه‌ش رو تو پیوی ببین 🔒"); return; }
    if (!fus.length) { await reply(c, "هنوز پیگیری‌ای نداری. بنویس مثلاً «ناصر @reza پولمو نمیده روزی ۳ بار یادش بنداز» یا /new"); return; }
    await reply(c, C.listText(c.r, fus, c.chat), { parse_mode: "HTML" });
  },
  async pause(c, a) {
    if (C.isBanned(c.r, c.user.id)) return;
    const fu = await need(c, a); if (!fu) return;
    if (fu.status !== "active") { await reply(c, "این پیگیری الان فعال نیست."); return; }
    fu.status = "paused"; await c.r.S.save();
    await reply(c, `⏸ پیگیری #${fa(fu.id)} متوقف شد.`);
  },
  async resume(c, a) {
    if (C.isBanned(c.r, c.user.id)) return;
    const fu = await need(c, a); if (!fu) return;
    if (fu.status !== "paused") { await reply(c, "این پیگیری متوقف نیست."); return; }
    if (!C.isAdmin(c.r, c.user) && C.openCount(c.r, fu.creator_id) > MAX_ACTIVE) { await reply(c, "سقف پیگیری‌های باز پره."); return; }
    if (fu.target_chat_id) { fu.status = "active"; fu.next_due = C.computeNext(fu); } else fu.status = "pending";
    await c.r.S.save();
    await reply(c, "▶️ ادامه پیدا کرد.\n" + C.fuLine(fu, c.chat.type !== "private"), { parse_mode: "HTML" });
  },
  async delete(c, a) {
    if (C.isBanned(c.r, c.user.id)) return;
    const fu = await need(c, a); if (!fu) return;
    delete DB(c.r).followups[String(fu.id)]; await c.r.S.save();
    await reply(c, `🗑 پیگیری #${fa(fu.id)} حذف شد.`);
  },
  async link(c, a) {
    if (C.isBanned(c.r, c.user.id)) return;
    const fu = await need(c, a); if (!fu) return;
    await reply(c, C.deepLink(c.r, fu), { link_preview_options: { is_disabled: true } });
  },
  async test(c, a) {
    if (C.isBanned(c.r, c.user.id)) return;
    const fu = await need(c, a); if (!fu) return;
    await reply(c, "⏳ دارم می‌نویسم...");
    const [txt, model] = await C.genFollowup(c.r, fu);
    await reply(c, `🧪 نمونه (فقط برای تو، برای طرف نرفت):\n\n${txt}\n\n— مدل: ${model}`);
  },
  async done(c, a) {
    if (C.isBanned(c.r, c.user.id)) return;
    const fu = await need(c, a); if (!fu) return;
    fu.status = "done"; await c.r.S.save();
    const k = fu.target_chat_id ? thxKb(fu.id) : undefined;
    await reply(c, `✅ پیگیری #${fa(fu.id)} تموم شد و دیگه پیامی نمی‌ره.` + (k ? "\nبراش پیام تشکر بفرستم؟" : ""), k ? { reply_markup: k } : {});
  },
  async all(c) {
    if (!(await adminGate(c, true))) return;
    const fus = C.scoped(Object.values(DB(c.r).followups), c.chat);
    if (!fus.length) { await reply(c, "هیچ پیگیری‌ای نیست." + (c.chat.type !== "private" ? " (برای همه، تو پیوی /all بزن 🔒)" : "")); return; }
    const pub = c.chat.type !== "private";
    const rows = fus.map((f) => `👤 ${esc(String(f.creator_name))}` + (pub ? "" : ` (<code>${f.creator_id}</code>) — ${esc(C.whereLabel(c.r, f))}`) + "\n" + C.fuLine(f, pub));
    for (let i = 0; i < rows.length; i += 15) await reply(c, rows.slice(i, i + 15).join("\n\n"), { parse_mode: "HTML" });
  },
  async ban(c, a) {
    if (!(await adminGate(c))) return;
    const n = norm(a[0]); if (!/^[+-]?\d+$/.test(n)) { await reply(c, "مثلاً: /ban 123456"); return; }
    const uid = parseInt(n, 10);
    if (uid === DB(c.r).owner) return;
    if (!DB(c.r).banned.includes(uid)) DB(c.r).banned.push(uid);
    let k = 0;
    for (const f of C.ownFus(c.r, uid)) if (["pending", "active"].includes(f.status)) { f.status = "paused"; k++; }
    await c.r.S.save();
    await reply(c, `⛔️ کاربر ${uid} بن شد و ${fa(k)} پیگیریش متوقف شد.`);
  },
  async unban(c, a) {
    if (!(await adminGate(c))) return;
    const n = norm(a[0]); if (!/^[+-]?\d+$/.test(n)) { await reply(c, "مثلاً: /unban 123456"); return; }
    const uid = parseInt(n, 10);
    DB(c.r).banned = DB(c.r).banned.filter((x) => x !== uid);
    await c.r.S.save(); await reply(c, `✅ کاربر ${uid} آزاد شد (پیگیری‌هاش متوقف موندن).`);
  },
  async voiceprob(c, a) {
    if (!(await adminGate(c))) return;
    const v0 = parseFloat(norm(a[0]));
    if (a.length && !isNaN(v0) && /^[+-]?(\d+\.?\d*|\.\d+)$/.test(norm(a[0]))) { const v = v0 > 1 ? v0 / 100 : v0; DB(c.r).voice_prob = Math.max(0, Math.min(1, v)); await c.r.S.save(); }
    await reply(c, `🎙 احتمال ویس: ${fa(Math.trunc(DB(c.r).voice_prob * 100))}٪  (مثلاً /voiceprob 30)`);
  },
  async voicestyle(c, a) {
    if (!(await adminGate(c))) return;
    const arg = (a[0] || "").trim(); const ok = a.length && arg in C.V.STYLES;
    if (ok) { DB(c.r).voice_style = arg; await c.r.S.save(); }
    const desc: Record<string, string> = { AB: "Farid بین گرم و بم، با تأکید ملایم (پیش‌فرض)", orig: "اولیه (Farid ساده)", A: "Farid گرم و واضح", B: "Farid بم و لوتی با مکث و تأکید", C: "piper gyro آفلاین (روی کلودفلر نیست؛ مثل AB)" };
    await reply(c, `🎙 سبک ویس: ${DB(c.r).voice_style} — ${desc[DB(c.r).voice_style]}\nگزینه‌ها: /voicestyle AB | A | B | C | orig`);
    if (ok) {
      const v = await C.V.synth("داداش، نوکرتم… این صدای جدیدمه، چطوره؟ مرام داری بگو!", DB(c.r).voice_style);
      if (v) await C.tgVoice(c.r, { chat_id: c.chat.id, caption: `نمونه‌ی سبک ${DB(c.r).voice_style}`, duration: v.duration }, v.audio);
    }
  },
  async stop(c) {
    const fu = targetFuFor(c);
    if (fu === "AMBIGUOUS") { await reply(c, "روی پیام همون پیگیری ریپلای کن و /stop بزن."); return; }
    if (!fu) { await reply(c, "فعلاً کسی ازت پیگیری نمی‌کنه، خیالت راحت 😎"); return; }
    await handleStop(c, fu, "/stop");
  },
};
async function adminGate(c: Ctx, isAll = false) {
  if (!C.isAdmin(c.r, c.user)) return false;
  if (c.chat.type !== "private" && !isAll) { await reply(c, "دستورهای مدیریتی فقط تو پیوی 🔒"); return false; }
  return true;
}

// ---------- /new wizard (was ConversationHandler) ----------
const wkey = (c: Ctx) => `w:${c.chat.id}:${c.user.id}`;
export async function wizardState(c: Ctx) {
  const w = await c.r.S.getState<any>(wkey(c));
  if (w && now() - w.ts > 1800) { await c.r.S.setState(wkey(c), null); return null; }
  return w;
}
export async function wizardNew(c: Ctx) {
  const u = c.user;
  if (C.isBanned(c.r, u.id)) return;
  if (c.chat.type !== "private") { await reply(c, "ساخت قدم‌به‌قدم فقط تو پیوی 🔒 — تو گروه بنویس «ناصر فلانی ...»"); return; }
  if (!C.isAdmin(c.r, u) && C.openCount(c.r, u.id) >= MAX_ACTIVE) { await reply(c, `داداش ${fa(MAX_ACTIVE)} تا پیگیری باز داری، سقفش همینه. یکی رو /done یا /delete کن.`); return; }
  await c.r.S.setState(wkey(c), { step: "NAME", d: {}, ts: now() });
  await reply(c, "👤 اسم طرف چیه؟ (همونی که تو پیام صداش می‌زنیم)\n/cancel برای لغو");
}
export async function wizardCancel(c: Ctx) { await c.r.S.setState(wkey(c), null); await reply(c, "لغو شد."); }
export async function wizardStep(c: Ctx, w: any) {
  const t0 = String(c.msg.text || "");
  const set = (step: string | null) => c.r.S.setState(wkey(c), step ? { step, d: w.d, ts: now() } : null);
  switch (w.step) {
    case "NAME": w.d.name = t0.trim().slice(0, 60); await set("SUBJECT");
      await reply(c, "📝 موضوع چیه؟ (مثلاً: پول قرضی، کتابی که برده، کاری که قول داده)"); return;
    case "SUBJECT": w.d.subject = t0.trim().slice(0, 200); await set("AMOUNT");
      await reply(c, "💰 مبلغ؟ (مثلاً ۲ میلیون تومن) — اگه مبلغ نداره بنویس «-»"); return;
    case "AMOUNT": { const t = t0.trim(); w.d.amount = ["-", "—", "ندارد", "نه"].includes(t) ? null : t.slice(0, 60); await set("SCHED");
      await reply(c, "⏱ هر چند وقت پیگیری کنم؟ نمونه‌ها:\n• «هر ۶ ساعت»\n• «هر ۲ روز»\n• «۱۰:۰۰ و ۱۸:۳۰» (ساعت‌های ثابت روزانه به وقت تهران)\nحداقل فاصله ۱ ساعته."); return; }
    case "SCHED": {
      let s = C.parseSchedule(t0);
      if (!s) { await reply(c, "متوجه نشدم 😅 یه چیزی مثل «هر ۸ ساعت» یا «هر ۱ روز» یا «۱۰:۰۰، ۲۰:۰۰» بنویس."); await set("SCHED"); return; }
      [s] = C.clampSchedule(c.r, s, c.user.id); w.d.schedule = s; await set("MAXC");
      await reply(c, `باشه: ${C.schedText(s)}.\n🔢 حداکثر چند تا پیام بفرستم؟ (عدد) — بی‌نهایت تا وقتی /done بزنی: «-»`); return;
    }
    case "MAXC": { const t = norm(t0); w.d.max_count = /^\d+$/.test(t) && parseInt(t, 10) > 0 ? parseInt(t, 10) : null; await set("TARGET");
      await reply(c, "🎯 طرف کیه؟\n• اگه قبلاً ربات رو استارت کرده، یوزرنیمش رو بفرست (مثلاً @reza)\n• وگرنه بنویس «لینک» تا یه لینک مخصوص بدم که براش بفرستی."); return; }
    case "TARGET": {
      const t = t0.trim(); await set(null);
      await C.firstCreationNotice(c.r, c.user);
      const fu = await C.newFu(c.r, { ...w.d, status: "pending", target_chat_id: null, target_username: null, sent_count: 0, history: [], last_sent: null, next_due: null,
        creator_id: c.user.id, creator_name: C.cname(c.user), mode: "private" });
      for (const k of ["target_user_id", "convo"]) if (!(k in w.d)) delete fu[k];  // Python wizard fu didn't carry these
      let msg = "";
      if (t.startsWith("@")) {
        const uname = t.slice(1).toLowerCase(); fu.target_username = uname;
        const cid = DB(c.r).users[uname];
        if (cid) { C.activate(fu, cid); msg = `✅ @${esc(uname)} پیدا شد، پیگیری فعال شد.`; }
        else msg = `⚠️ @${esc(uname)} هنوز ربات رو استارت نکرده. این لینک رو براش بفرست:`;
      } else msg = "🔗 این لینک رو برای طرف بفرست. وقتی Start بزنه پیگیری خودکار شروع می‌شه و خبرت می‌کنم:";
      await c.r.S.save();
      if (fu.status === "pending") msg += `\n${C.deepLink(c.r, fu)}`;
      await reply(c, msg + "\n\n" + C.fuLine(fu) + `\n\nنمونه پیام: /test ${fu.id}`, { parse_mode: "HTML", link_preview_options: { is_disabled: true } });
      return;
    }
  }
}

// ---------- callbacks ----------
export async function onCallback(r: R, q: any) {
  const [act, fid] = String(q.data || "").split(":");
  const fu = DB(r).followups[fid];
  const answer = () => tg(r, "answerCallbackQuery", { callback_query_id: q.id }).catch(() => {});
  const edit = (text: string, extra: any = {}) => tg(r, "editMessageText", { chat_id: q.message.chat.id, message_id: q.message.message_id, text, ...extra });
  if (!fu || !C.canManage(r, q.from.id, fu)) { await answer(); return; }
  await answer();
  if (act === "thx" || act === "nothx") {
    if (act === "thx" && fu.target_chat_id) {
      const txt = await C.genThanks(r, fu);
      await tg(r, "sendMessage", { chat_id: fu.target_chat_id, text: txt });
      await edit(`✅ پیگیری #${fa(fid)} تموم شد. پیام تشکر رفت:\n\n${txt}`);
    } else await edit(`✅ پیگیری #${fa(fid)} تموم شد.`);
  } else if (act === "cdone") {
    fu.status = "done"; await r.S.save();
    await edit(`✅ پیگیری #${fa(fid)} (${fu.name}) بسته شد. براش تشکر بفرستم؟`, { reply_markup: thxKb(fid, "🌹 پیام تشکر بفرست") });
  } else if (act === "nodone") {
    await edit(`باشه، پیگیری #${fa(fid)} ادامه داره 😏`);
  }
}

// ---------- conversational layer ----------
function fusBrief(r: R, uid: number, chat: any) {
  const rows: string[] = [];
  for (const f of C.scoped(C.ownFus(r, uid, !chat || chat.type === "private"), chat)) {
    if (f.status === "done" && now() - (f.created || 0) > 7 * 86400) continue;
    const where = f.mode === "group" ? "گروه" : "پیوی";
    rows.push((f.creator_id === uid ? "" : `[مال ${f.creator_name}] `) + `#${f.id} | ${f.name} | ${({ female: "خانم", male: "آقا" } as any)[f.gender] || "جنسیت نامعلوم"} | @${f.target_username || "-"} | ${C.subj(f)} | ${(STATUS as any)[f.status]} | ${where} | ${C.schedText(f.schedule)}`);
  }
  return rows.join("\n") || "(هیچی)";
}
async function buildOwnerPrompt(c: Ctx, text: string) {
  const { r, chat, msg, user: me } = c; const nm = C.cname(me);
  const p0 = teh(now());
  let p = `نوع چت: ${isGroup(chat) ? "گروه «" + (chat.title || "") + "»" : "پیوی با " + nm}\n`;
  p += `زمان الان (تهران): ${p0.y}-${pad2(p0.mo)}-${pad2(p0.d)} ${pad2(p0.h)}:${pad2(p0.mi)}\n`;
  p += "پیگیری‌های موجود:\n" + fusBrief(r, me.id, chat) + "\n";
  p += "درباره‌ی کسی که داره باهات حرف می‌زنه (تو reply): " + C.genderHint(c.ug as any, nm) + "\n";
  p += 'یه فیلد اضافه هم بده: "target_gender": "female" اگه گفته طرف خانمه/دختره/آبجیه یا اسمش زنونه‌ست (مثل طلا، سارا، مینا)، "male" اگه گفته پسره/آقاست یا اسمش مردونه‌ست، وگرنه null. اگه درباره‌ی یه پیگیری موجود گفت «فلانی خانمه» یا «پسره»، action رو edit بذار با target_gender. وقتی تو reply درباره‌ی طرف حرف می‌زنی، جنسیتش رو رعایت کن.\n';
  if (!C.isAdmin(r, me)) p += `محدودیت این کاربر: حداکثر روزی ${MAX_PER_DAY} پیام برای هر پیگیری (اگه بیشتر خواست، تو reply بگو سقفش روزی ${MAX_PER_DAY} باره) و حداکثر ${MAX_ACTIVE} پیگیری باز.\n`;
  if (isGroup(chat)) {
    p += "مهم: این گفتگو تو گروهه؛ فقط درباره‌ی پیگیری‌های همین گروه که بالا اومده حرف بزن و هیچ‌وقت از پیگیری‌های خصوصی یا پیوی حرفی نزن.\n";
    const ms = Object.entries(C.members(r, chat.id)).sort((a, b) => (b[1].seen || 0) - (a[1].seen || 0)).slice(0, 80);
    p += "اعضای دیده‌شده‌ی این گروه (user_id | اسم | یوزرنیم):\n" + ms.map(([uid, m]) => `${uid} | ${C.mname(m)} | @${m.username || "-"}` + (Number(uid) === me.id ? ` (خودِ ${nm} که داره باهات حرف می‌زنه)` : "")).join("\n") + "\n";
    p += 'اگه طرف یکی از این اعضاست، یه فیلد اضافه هم بده: "target_user_ids": [آیدی‌های عددیِ اعضای محتمل] (با درنظر گرفتن فینگلیش/فارسی و اسم کوچیک). اگه هیچکی نخورد [] بذار.\n';
    p += 'فیلد "delivery": "private" اگه گفت پیوی/خصوصی بهش پیام بده، وگرنه "group".\n';
    p += 'برای create یه فیلد "first_line" هم بده: یه تیکه‌ی لوتی و بامزه‌ی ۱ جمله‌ای خطاب به خود طرف درباره‌ی موضوع، که با اسم واقعیش (display_name یا اسم کوچیکش، نه یوزرنیم) صداش کنه؛ هیچ‌وقت @ یا یوزرنیم ننویس.\n';
  }
  const rt = msg.reply_to_message;
  if (rt && rt.from && !rt.from.is_bot && rt.from.id !== me.id) p += `${nm} روی پیام این آدم ریپلای کرده: ${C.fullName(rt.from)} (@${rt.from.username || "-"})\n`;
  const h = await histGet(c, me.id);
  if (h.length) p += "تاریخچه‌ی گفتگوی اخیر:\n" + h.join("\n") + "\n";
  p += `\nپیام جدید ${nm}: ${text}`;
  return p;
}
function findFu(r: R, d: any, uid: number, chat: any): FU[] {
  const mine = C.scoped(C.ownFus(r, uid, !chat || chat.type === "private"), chat);
  if (T(d.id)) { const f = DB(r).followups[norm(String(d.id))]; if (f && mine.includes(f)) return [f]; }
  const ownList = mine.filter((f) => f.creator_id === uid);
  const own = ownList.length ? ownList : mine;
  const act = own.filter((f) => !["done", "stopped"].includes(f.status));
  const cands = act.length ? act : own;
  const out: FU[] = [];
  const un = C.nz(d.target_username), nm = C.nz(d.target_name);
  for (const f of cands) {
    if (un && C.nz(f.target_username) === un) out.push(f);
    else if (nm && (C.nz(f.name).includes(nm) || nm.includes(C.nz(f.name)))) out.push(f);
  }
  return out;
}
function normSchedule(s: any): any {
  if (!s || typeof s !== "object" || Array.isArray(s)) return null;
  const t = s.type;
  try {
    if (t === "per_day") { const n = norm(String(s.count || 1)); if (!/^[+-]?\d+$/.test(n)) return null; return { type: "times", times: C.spreadPerDay(parseInt(n, 10)) }; }
    if (t === "interval") { const h = Number(norm(String(s.hours))); if (!isFinite(h) || norm(String(s.hours)) === "") return null; return { type: "interval", hours: Math.max(1.0, h) }; }
    if (t === "times") { const ts = C.parseSchedule((s.times || []).join(" ")); return ts && ts.type === "times" ? ts : null; }
  } catch { return null; }
  return null;
}
const intOrNull = (x: any) => { const n = norm(String(x)); return /^[+-]?\d+$/.test(n) ? parseInt(n, 10) : undefined; };

export async function handleOwner(c: Ctx, text: string) {
  const { r, chat, msg, user: me } = c;
  if (!(await C.llmAllowed(r, me.id))) {
    const w = (await r.S.getState<number>(`rlw:${me.id}`)) || 0;
    if (now() - w > 600) { await r.S.setState(`rlw:${me.id}`, now()); await reply(c, "داداش یه نفس بگیر 😅 ساعتی ۲۰ تا پیام بیشتر نمی‌تونم جواب بدم. یه کم دیگه بیا، یا از /list و /pause استفاده کن."); }
    return;
  }
  DB(r).names[String(me.id)] = C.cname(me);
  await tg(r, "sendChatAction", { chat_id: chat.id, action: "typing" }).catch(() => {});
  const prompt = await buildOwnerPrompt(c, text);
  await histAdd(c, C.cname(me), text, me.id);
  const [d, model] = await C.llmJson(r, OWNER_SYS.split("حامد").join(C.cname(me)), prompt);
  log("intent", me.id, model, d?.action);
  if (!d) { await ownerReply(c, "داداش یه لحظه سیم‌هام قاطی شد 😅 یه بار دیگه بگو، یا از دستورها مثل /new و /list استفاده کن."); return; }
  const act = String(d.action || "chat").toLowerCase();
  let rep = esc(d.reply || "");
  const vpref = VOICE_RE.test(text) ? "always" : (NOVOICE_RE.test(text) ? "never" : null);
  await r.S.setState(`vp:${chat.id}:${me.id}`, vpref);
  if (act === "chat" || act === "clarify") {
    if (vpref === "always" || (act === "chat" && Math.random() < Number(DB(r).voice_prob ?? 0.28) / 2)) {
      let short = String(d.reply || "جانم داداش؟");
      if (words(short).length > C.V.MAX_WORDS) {
        const [t2] = await C.llm(r, [{ role: "system", content: "این متن رو با همون لحن لوتی، حداکثر ۲۵ کلمه و گفتاری خلاصه کن. فقط متن." }, { role: "user", content: short }], 150);
        short = t2 || short;
      }
      await C.sendVoiceOrText(r, chat.id, short, null, msg.message_id, true);
      await histAdd(c, "ناصر", short, me.id); return;
    }
    await ownerReply(c, rep || "جانم داداش؟"); return;
  }
  if (act === "list") {
    const fus = C.scoped(C.ownFus(r, me.id), chat);
    const body = C.listText(r, fus, chat) || (isGroup(chat) ? "تو این گروه پیگیری‌ای نداری؛ بقیه رو تو پیوی ببین 🔒" : "فعلاً کسی تو لیست نیست.");
    await ownerReply(c, (rep && fus.length ? rep + "\n\n" : "") + body); return;
  }
  if (act === "create") { await doCreate(c, d, rep); return; }
  const fs = findFu(r, d, me.id, chat);
  if (!fs.length) {
    await ownerReply(c, "کدوم پیگیری داداش؟ شماره یا اسمش رو بگو.\n\n" + (C.listText(r, C.scoped(C.ownFus(r, me.id), chat), chat) || "فعلاً پیگیری‌ای نداری" + (isGroup(chat) ? " (تو این گروه)." : "."))); return;
  }
  if (fs.length > 1) { await ownerReply(c, "چند تا جور درمیاد، کدومش؟\n\n" + fs.map((f) => C.fuLine(f, isGroup(chat))).join("\n\n")); return; }
  const fu = fs[0];
  if (vpref && ["edit", "resume", "test"].includes(act)) { fu.voice = vpref; await r.S.save(); rep += " 🎙 ویس: " + (vpref === "always" ? "همیشه" : "خاموش"); }
  if (act === "edit") {
    let s = normSchedule(d.schedule);
    if (s) { let cnote: string; [s, cnote] = C.clampSchedule(r, s, fu.creator_id); fu.schedule = s; rep += esc(cnote); }
    for (const k of ["subject", "amount"]) if (T(d[k])) fu[k] = String(d[k]).slice(0, 200);
    if (T(d.display_name) && !String(d.display_name).startsWith("@")) {
      const nn = await C.toFaName(r, String(d.display_name));
      if (nn && nn !== "رفیق") { fu.name = nn; fu.name_source = "given"; C.memPut(r, fu.target_user_id, fu.target_username, nn, "given", fu.creator_id); }
    }
    if (T(d.notes)) fu.notes = [...(fu.notes || []), String(d.notes).slice(0, 300)].slice(-5);
    const tg0 = C.normGender(d.target_gender);
    if (tg0 && tg0 !== "unknown") { fu.gender = tg0; fu.gender_source = "given"; }
    if (d.max_count !== null && d.max_count !== undefined) { const n = intOrNull(d.max_count); if (n !== undefined) fu.max_count = n || null; }
    if (fu.status === "active") fu.next_due = C.computeNext(fu);
    await r.S.save(); await ownerReply(c, (rep || "ردیفه.") + "\n\n" + C.fuLine(fu, isGroup(chat))); return;
  }
  if (act === "pause") {
    if (fu.status === "active") { fu.status = "paused"; await r.S.save(); }
    await ownerReply(c, (rep || "باشه، فعلاً ولش می‌کنم.") + "\n\n" + C.fuLine(fu, isGroup(chat))); return;
  }
  if (act === "resume") {
    if (fu.status === "paused" && (C.isAdmin(r, me) || C.openCount(r, fu.creator_id) <= MAX_ACTIVE)) {
      fu.status = fu.target_chat_id ? "active" : "pending";
      if (fu.status === "active") fu.next_due = C.computeNext(fu);
      await r.S.save();
    }
    await ownerReply(c, (rep || "دوباره افتادم دنبالش.") + "\n\n" + C.fuLine(fu, isGroup(chat))); return;
  }
  if (act === "delete") { delete DB(r).followups[String(fu.id)]; await r.S.save(); await ownerReply(c, (rep || "پاکش کردم.") + ` (#${fa(fu.id)})`); return; }
  if (act === "link") { await ownerReply(c, (rep ? rep + "\n" : "") + C.deepLink(r, fu)); return; }
  if (act === "test") {
    const asVoice = vpref === "always" || fu.voice === "always";
    const [txt] = await C.genFollowup(r, fu, asVoice);
    if (asVoice) { await C.sendVoiceOrText(r, chat.id, txt, "🧪 نمونه (برای طرف نرفت)", null, true); return; }
    await ownerReply(c, `🧪 نمونه (برای طرف نرفت):\n\n${esc(txt)}`); return;
  }
  if (act === "done") {
    fu.status = "done"; await r.S.save();
    const k = fu.target_chat_id ? thxKb(fu.id, "🌹 پیام تشکر بفرست") : null;
    await ownerReply(c, (rep || "دمش گرم، تمومش کردم.") + `\n✅ #${fa(fu.id)} بسته شد.` + (k ? "\nبراش تشکر بفرستم؟" : ""), k ? { reply_markup: k } : {}); return;
  }
  await ownerReply(c, rep || "متوجه نشدم داداش، یه جور دیگه بگو.");
}

async function doCreate(c: Ctx, d: any, rep: string) {
  const { r, chat, msg, user: me } = c;
  if (!C.isAdmin(r, me) && C.openCount(r, me.id) >= MAX_ACTIVE) { await ownerReply(c, `داداش دستت پره، ${fa(MAX_ACTIVE)} تا پیگیری باز داری 😅 یکی رو تموم یا پاک کن («ناصر لیست» رو بزن).`); return; }
  const subject = String(d.subject || "").trim();
  if (!subject) { await ownerReply(c, rep || "موضوع چیه داداش؟ پول؟ قول؟ چی ازش طلب داری؟"); return; }
  let sched = normSchedule(d.schedule) || { type: "times", times: C.spreadPerDay(3) };
  let cnote: string; [sched, cnote] = C.clampSchedule(r, sched, me.id);
  let maxc: number | null = null;
  if (T(d.max_count)) { const n = intOrNull(d.max_count); maxc = n === undefined ? null : n; }
  let isSelf = T(d.self);
  let uname: string | null = isSelf ? null : (C.nz(d.target_username) || null);
  let tname: string | null = isSelf ? null : (String(d.target_name || "").trim() || null);
  let uid: number | null = isSelf ? me.id : null;
  const rt = msg.reply_to_message;
  if (rt && rt.from && !rt.from.is_bot && (T(d.use_replied_user) || !(uname || tname))) {
    uid = rt.from.id; tname = tname || rt.from.first_name; uname = uname || ((rt.from.username || "").toLowerCase() || null);
  }
  if (uid === me.id) isSelf = true;
  if (isGroup(chat) && !uid) {
    const mem = C.members(r, chat.id);
    if (uname) {
      for (const [k, m] of Object.entries(mem)) if (m.username === uname) { uid = Number(k); tname = tname || m.first || C.mname(m); }
    } else if (tname) {
      const llmIds = ((Array.isArray(d.target_user_ids) ? d.target_user_ids : []) as any[]).map((x) => norm(String(x))).filter((x) => /^\d+$/.test(x) && x in mem).map(Number);
      let cands = [...new Set([...llmIds, ...C.codeMatch(r, chat.id, tname)])];
      if (!llmIds.length && cands.length > 1) { /* keep */ } else if (llmIds.length) cands = llmIds;
      if (cands.length === 1) { uid = cands[0]; tname = tname || mem[String(uid)].first || C.mname(mem[String(uid)]); }
      else if (cands.length > 1) {
        const opts = cands.map((x) => `• ${esc(C.mname(mem[String(x)]))}` + (mem[String(x)].username ? ` (@${mem[String(x)].username})` : "")).join("\n");
        await ownerReply(c, `داداش چند تا «${esc(tname)}» داریم، کدومش؟ رو پیامش ریپلای کن و دوباره بگو، یا یوزرنیمش رو بده:\n${opts}`); return;
      } else { await ownerReply(c, `«${esc(tname)}» رو تو این گروه هنوز ندیدم 🤔 رو یکی از پیام‌هاش ریپلای کن و بگو «ناصر این...»، یا @یوزرنیمش رو بده.`); return; }
    }
  }
  if (!(uid || uname || tname || isSelf)) { await ownerReply(c, rep || "از کی پیگیری کنم داداش؟ اسمش یا @یوزرنیمش رو بگو."); return; }
  let nameSrc: string | null = "given", name = "";
  if (!isSelf) {
    if (rt && uid && rt.from && rt.from.id === uid && rt.from.first_name) DB(r).tg_names[String(uid)] = rt.from.first_name;
    let given: string | null = String(d.display_name || "").trim() || (tname && C.hasFa(tname) ? tname : null);
    if (!given && tname && !uname && !uid) given = tname;
    [name, nameSrc] = await C.resolveDisplay(r, uid, uname, given, me.id);
  }
  let delivery: string;
  if (isSelf) {
    name = C.cname(me);
    delivery = (isGroup(chat) && String(d.delivery || "").toLowerCase() === "group" && /(همین\s*جا|تو\s*گروه|اینجا)/.test(msg.text || "")) ? "group" : "private";
  } else delivery = (!isGroup(chat) || String(d.delivery || "").toLowerCase() === "private") ? "private" : "group";
  await C.firstCreationNotice(r, me);
  const vp = await r.S.getState<string>(`vp:${chat.id}:${me.id}`);
  const fu = await C.newFu(r, { voice: vp || "auto", creator_id: me.id, creator_name: C.cname(me), name, subject: subject.slice(0, 200), amount: T(d.amount) ? String(d.amount).slice(0, 60) : null,
    schedule: sched, max_count: maxc, target_username: uname, target_user_id: uid, origin_chat: chat.id, mode: delivery, self: isSelf, recurring: T(d.recurring),
    name_source: isSelf ? "given" : nameSrc, notes: T(d.notes) ? [String(d.notes).slice(0, 300)] : [] });
  const gGiven = C.normGender(d.target_gender);
  if (isSelf) { fu.gender = c.ug || "unknown"; fu.gender_source = "inferred"; }
  else if (gGiven && gGiven !== "unknown") { fu.gender = gGiven; fu.gender_source = "given"; }
  else await C.ensureGender(r, fu);
  let extra = esc(cnote);
  if (delivery === "group") { fu.target_chat_id = chat.id; fu.status = "active"; }
  else {
    const dm = (uid && DB(r).started.includes(uid)) ? uid : (uname ? DB(r).users[uname] : null);
    if (dm && DB(r).started.includes(dm)) { fu.target_chat_id = dm; fu.status = "active"; }
    else extra = isSelf ? `\n\n⚠️ داداش اول یه بار تو پیوی منو استارت کن تا بتونم پیام بدم، همین لینکو بزن:\n${C.deepLink(r, fu)}`
      : `\n\n⚠️ ${esc(name)} هنوز ربات رو استارت نکرده، پیوی نمی‌تونم بهش پیام بدم. این لینک رو بزنه و Start کنه، خودم شروع می‌کنم:\n${C.deepLink(r, fu)}`;
  }
  if (fu.status === "active") fu.next_due = C.computeNext(fu);
  if (isSelf) await C.refreshName(r, fu);   // Latin first name -> Persian for self reminders
  await r.S.save();
  if (isGroup(chat) && delivery !== "group") {
    await C.notify(r, me.id, (rep || "ردیفه داداش.") + "\n\n📋 " + C.fuLine(fu) + extra, null, { parse_mode: "HTML", link_preview_options: { is_disabled: true } });
    let pub = "ردیفه داداش 😎 جزئیاتش رو پیوی برات فرستادم 🔒";
    if (!isSelf && fu.status === "pending") pub += `\nطرف باید اینو بزنه و Start کنه: ${C.deepLink(r, fu)}`;
    if (!DB(r).started.includes(me.id)) pub += `\n(اول یه بار پیوی @${r.botUsername} رو استارت کن که بتونم جزئیات رو برات بفرستم.)`;
    await histAdd(c, "ناصر", pub, me.id);
    await replyText(r, msg, C.genderFix(pub, c.ug as any), { link_preview_options: { is_disabled: true } });
  } else {
    await ownerReply(c, (rep || `خیالت تخت داداش، افتادم دنبال ${esc(name)}.`) + "\n\n📋 " + C.fuLine(fu, isGroup(chat)) + extra);
  }
  if (fu.status === "active") {
    let first = delivery === "group" ? C.scrubIds(String(d.first_line || "").trim(), fu) : "";
    if (first && !first.includes(fu.name)) first = `${fu.name} جان، ${first}`;
    first = C.genderFix(first, fu.gender);
    const asVoice = C.wantVoice(r, fu);
    if (!first || (asVoice && words(first).length > C.V.MAX_WORDS)) [first] = await C.genFollowup(r, fu, asVoice);
    try {
      await C.sendToTarget(r, fu, first, asVoice);
      fu.sent_count += 1; fu.last_sent = now(); fu.history.push(first); fu.sent_log = [fu.last_sent];
      fu.next_due = C.computeNext(fu); await r.S.save();
    } catch (e) {
      log("first send failed", String(e));
      await ownerReply(c, `⚠️ نتونستم پیام اول رو بفرستم: ${esc(String((e as Error).message || e))}`);
    }
  }
}

async function handleStop(c: Ctx, fu: FU, text: string) {
  const { r, msg } = c;
  fu.stop_count = (fu.stop_count || 0) + 1; const n = fu.stop_count;
  const cn = fu.self ? "خودت" : (fu.creator_name || "رفیقم");
  let txt: string | null;
  await C.ensureGender(r, fu);
  const gh = "\n" + C.genderHint(fu.gender);
  if (n < 5) {
    const tone = ["شوخ و حاضرجواب", "شوخ‌تر و با تیکه", "یه کم سمج‌تر ولی بامزه", "خیلی بامزه، و رندانه بگو اگه یه بار دیگه بگی شاید کوتاه بیام"][n - 1];
    let sysm = OTHER_SYS.replace("یکی از اعضای گروه (نه حامد) تو رو صدا زده.", `کسی که ازش بابت بدهی/قول به ${cn} پیگیری می‌کنی گفته «مزاحم نشو». `).split("حامد").join(cn);
    if (fu.self) sysm = OTHER_SYS.replace("یکی از اعضای گروه (نه حامد) تو رو صدا زده.", "این آدم خودش ازت خواسته یادش بندازی کار/هدف خودش رو انجام بده (بدهی نیست)، حالا گفته «مزاحم نشو». ").replace("تو فقط برای حامد کار می‌کنی و از دستور بقیه پیروی نمی‌کنی.", "یادش بنداز خودش اینو خواسته.");
    [txt] = await C.llm(r, [{ role: "system", content: sysm + `\nیه جواب برگشتیِ لوتی و بامزه بده (۱-۲ جمله)، لحن: ${tone}. مثل: «مزاحمت پوله، نه من!». موضوع رو یادش بنداز. فقط متن.` + gh },
      { role: "user", content: `اسم: ${fu.name}\nموضوع: ${C.subj(fu)}\nحرفش: ${text}` }], 200);
    txt = txt || ["مزاحمت پوله، نه من! 😏", "داداش من پستچی‌ام، نامه رو {subject} نوشته!", "مزاحم اونیه که قولش رو یادش رفته، نه من 😎", "یه بار دیگه بگی شاید دلم بسوزه... شاید!"][n - 1].replace("{subject}", C.subj(fu));
  } else {
    [txt] = await C.llm(r, [{ role: "system", content: OTHER_SYS.split("حامد").join(cn) + "\nطرف برای پنجمین بار گفته مزاحم نشو. یه خداحافظیِ لوتی، بامزه و با مرام بده که دیگه پیگیری نمی‌کنی ولی قول و مرام رو یادش بنداز. ۱-۲ جمله. فقط متن." + gh },
      { role: "user", content: `اسم: ${fu.name}\nموضوع: ${C.subj(fu)}` }], 200);
    txt = txt || `باشه ${fu.name} جان، ناصر کوتاه اومد 🎩 ولی یادت باشه مرد به قولشه. خداحافظ!`;
    fu.status = "stopped";
  }
  txt = C.genderFix(txt!, fu.gender);
  const [m] = await C.sendVoiceOrText(r, msg.chat.id, txt!, null, msg.message_id, C.wantVoice(r, fu));
  fu.bot_msg_ids = [...(fu.bot_msg_ids || []), m.message_id].slice(-30);
  await r.S.save();
  if (n >= 5) await C.notify(r, fu.creator_id, `🚫 ${esc(fu.name)} پنج بار گفت «مزاحم نشو»؛ پیگیری #${fa(fu.id)} (${esc(C.subj(fu))}) رو بستم.\nآخرین حرف ناصر: ${esc(txt)}`, fu, { parse_mode: "HTML" });
  else await C.notify(r, fu.creator_id, `😏 ${esc(fu.name)} گفت مزاحم نشو (${fa(n)} از ۵) — #${fa(fu.id)}\n«${esc(text.slice(0, 300))}»\nناصر: ${esc(txt)}`, fu, { parse_mode: "HTML" });
}

async function handleTarget(c: Ctx, fu: FU, text: string) {
  const { r, msg, user: u } = c;
  if (!fu.target_user_id) fu.target_user_id = u.id;
  if (STOP_RE.test(text || "")) return handleStop(c, fu, text);
  if (!(await C.llmAllowed(r, u.id))) { await C.notify(r, fu.creator_id, `💬 #${fa(fu.id)} ${esc(fu.name)}: «${esc(text.slice(0, 500))}»`, null, { parse_mode: "HTML" }); return; }
  const cn = fu.creator_name || "رفیقم";
  const convo: string[] = (fu.convo ||= []);
  let p = `اسم طرف: ${fu.name} (با همین اسم صداش کن، یوزرنیم ننویس)\nموضوع: ${C.subj(fu)}\n`
    + (T(fu.notes) ? "توضیحات صاحب‌کار: " + fu.notes.slice(-5).join(" | ") + "\n" : "")
    + `تعداد پیگیری‌های قبلی: ${fu.sent_count || 0}\n`
    + `آخرین پیام‌های تو: ${(fu.history || []).slice(-3).join(" | ")}\n`
    + (convo.length ? "گفتگوی قبلی:\n" + convo.slice(-6).join("\n") + "\n" : "") + C.genderHint(await C.ensureGender(r, fu)) + "\n" + `\nجواب جدید طرف: ${text}`;
  let tsys = TARGET_SYS.split("حامد").join(cn);
  if (fu.self) {
    tsys = TARGET_SYS.replace("کسی که ازش پیگیری می‌کنی بهت جواب داده", "خودِ کسی که ازت خواسته یادش بندازی کار/هدفش رو انجام بده (یادآور شخصی، نه بدهی) جواب داده").split("حامد").join("خودش");
    p = p.replace("اسم طرف:", "اسم خودش:").replace("موضوع:", "کار/هدفش:");
  }
  const [d] = await C.llmJson(r, tsys, p, 500);
  const intent = (d || {}).intent || "other";
  if (d && T(d.reply)) d.reply = C.genderFix(C.scrubIds(String(d.reply), fu), fu.gender);
  if (intent === "stop") return handleStop(c, fu, text);
  let replyTxt: string | null = (d && T(d.reply)) ? String(d.reply) : C.genderFix(`پیامت رو گرفتم داداش، به ${cn} می‌رسونم 👍`, fu.gender);
  convo.push(`طرف: ${text}`, `ناصر: ${replyTxt}`); fu.convo = convo.slice(-12);
  if (fu.self && intent === "paid") replyTxt = null;
  if (replyTxt !== null) {
    try {
      const [m] = await C.sendVoiceOrText(r, msg.chat.id, replyTxt, null, msg.message_id, C.wantVoice(r, fu) && words(replyTxt).length <= 40);
      fu.bot_msg_ids = [...(fu.bot_msg_ids || []), m.message_id].slice(-30);
    } catch (e) { log("target reply failed", String(e)); }
  }
  if (intent === "promise" && T(d?.when)) fu.promise = d.when;
  if (fu.self && intent === "paid") {
    if (fu.recurring) {
      const p0 = teh(now());
      fu.skip_until = tehTs(p0.y, p0.mo, p0.d, 23, 59); fu.next_due = C.computeNext(fu);
      await replyText(r, msg, C.genderFix(`✅ دمت گرم ${fu.name}! امروزت ثبت شد، فردا دوباره می‌آم سراغت 😎`, fu.gender));
    } else {
      fu.status = "done";
      await replyText(r, msg, C.genderFix(`✅ دمت گرم ${fu.name}، مرد کار خودتی! «${fu.subject}» رو بستم.`, fu.gender));
    }
  }
  await r.S.save();
  if (fu.self) return;
  const labels: Record<string, string> = { promise: "🤝 قول داد", paid: "💰 می‌گه پرداخت کرده", refuse: "🙅 زیرش زد", excuse: "🫠 بهونه آورد", question: "❓ سوال پرسید", other: "💬 جواب داد" };
  let head = `${labels[intent] || "💬"} — #${fa(fu.id)} ${esc(fu.name)} (${esc(C.subj(fu))})`;
  if (intent === "promise" && T(d?.when)) head += `\nزمان قول: ${esc(String(d.when))}`;
  let body = `${head}\n\n«${esc(text.slice(0, 800))}»\n\nناصر جوابش داد: ${esc(replyTxt)}`;
  let k: any = undefined;
  if (intent === "paid") { body += "\n\nتایید می‌کنی تموم شده؟"; k = kb([[["✅ آره، تمومش کن", `cdone:${fu.id}`], ["❌ نه هنوز", `nodone:${fu.id}`]]]); }
  await C.notify(r, fu.creator_id, body, null, { parse_mode: "HTML", ...(k ? { reply_markup: k } : {}) });
}

function triggered(c: Ctx, text: string) {
  if (/ناصر/.test(text || "")) return true;
  if (c.r.botUsername && (text || "").toLowerCase().includes(`@${c.r.botUsername.toLowerCase()}`)) return true;
  const rt = c.msg.reply_to_message;
  return !!(rt && rt.from && rt.from.id === c.r.botId);
}
export function targetFuFor(c: Ctx): FU | "AMBIGUOUS" | null {
  const { r, chat, user: u, msg } = c;
  const act = Object.values(DB(r).followups).filter((f) => ["active", "paused"].includes(f.status) && f.target_chat_id === chat.id);
  const rt = msg.reply_to_message;
  const text = msg.text || "";
  if (!isGroup(chat)) {
    if (rt) for (const f of act) if ((f.bot_msg_ids || []).includes(rt.message_id)) return f;
    if (act.length && (!C.ownFus(r, u.id).length || STOP_RE.test(text))) {
      if (new Set(act.map((f) => f.creator_id)).size > 1) return "AMBIGUOUS";
      return act[act.length - 1];
    }
    const selfs = act.filter((f) => f.self);
    if (selfs.length && SELFDONE_RE.test(text) && selfs.length === 1) return selfs[0];
    return null;
  }
  const isT = (f: FU) => f.target_user_id === u.id || (u.username && f.target_username === u.username.toLowerCase());
  for (const f of act) if (isT(f) && rt && (f.bot_msg_ids || []).includes(rt.message_id)) return f;
  for (const f of act) {
    if (isT(f)) {
      if (f.self && !(SELFDONE_RE.test(text) || STOP_RE.test(text))) continue;
      return f;
    }
  }
  return null;
}

export async function onText(c: Ctx) {
  const { r, chat, user: u, msg } = c;
  if (!msg || !u) return;
  const text: string = msg.text || msg.caption || "";
  if (isGroup(chat)) {
    C.registerMember(r, chat, u);
    if (msg.reply_to_message?.from) C.registerMember(r, chat, msg.reply_to_message.from);
    if (!text || !triggered(c, text)) return;
    if (C.isBanned(r, u.id)) return;
    const fu = targetFuFor(c);
    if (fu && fu !== "AMBIGUOUS") return handleTarget(c, fu, text);
    return handleOwner(c, text);
  }
  C.rememberUser(r, u, chat.id); C.markStarted(r, u.id); await r.S.save();
  if (C.isBanned(r, u.id) || !text) return;
  const fu = targetFuFor(c);
  if (fu === "AMBIGUOUS") { await reply(c, "داداش چند نفر از طریق من پیگیرتن 😅 روی پیام همون پیگیری‌ای که جوابش رو می‌دی ریپلای کن تا به آدم درستش برسونم."); return; }
  if (fu) return handleTarget(c, fu, text);
  return handleOwner(c, text);
}
export const isTriggered = triggered;

export function onMembers(c: Ctx) {
  for (const m of c.msg.new_chat_members || []) { if (m.id === c.r.botId) continue; C.registerMember(c.r, c.chat, m); }
}
export async function onMyMember(r: R, cm: any) {
  const chat = cm.chat;
  if (!isGroup(chat)) return;
  if (["member", "administrator"].includes(cm.new_chat_member.status) && ["left", "kicked"].includes(cm.old_chat_member.status)) {
    DB(r).groups[String(chat.id)] ||= { title: chat.title ?? null, members: {} }; await r.S.save();
    if (cm.from) C.registerMember(r, chat, cm.from);
    try { await tg(r, "sendMessage", { chat_id: chat.id, text: "سلام به همه 👋 ناصرم، پیگیرِ لوتی. هر کی از کسی طلب داره یا قولی گرفته، کافیه بگه «ناصر فلانی پولمو نمیده روزی ۳ بار یادش بنداز»، بقیه‌ش با من 😎\n(برای اینکه منو تو گروه با اسم صدا کنید، یه بار تو پیوی @" + r.botUsername + " استارت بزنید هم بد نیست.)" }); } catch {}
    if (cm.from) await C.notify(r, cm.from.id, `➕ منو اضافه کردی به گروه «${esc(chat.title || "")}». اونجا بگو «ناصر فلانی ...» تا شروع کنم.`, null, { parse_mode: "HTML" });
    if (cm.from && cm.from.id !== DB(r).owner) await C.notifyOwner(r, `➕ ${esc(C.fullName(cm.from))} منو اضافه کرد به گروه «${esc(chat.title || "")}»`, { parse_mode: "HTML" });
  }
}
export async function onMigrate(r: R, msg: any) {
  if (msg.migrate_to_chat_id) {
    const old = msg.chat.id, nw = msg.migrate_to_chat_id;
    for (const f of Object.values(DB(r).followups)) if (f.target_chat_id === old) f.target_chat_id = nw;
    const g = DB(r).groups[String(old)];
    if (g) { delete DB(r).groups[String(old)]; DB(r).groups[String(nw)] = g; }
    await r.S.save();
  }
}

// ---------- scheduler ----------
export async function tickOne(r: R, fu: FU) {
  const t = now();
  if (fu.status !== "active" || !fu.target_chat_id) return;
  if (!fu.next_due) { fu.next_due = C.computeNext(fu); await r.S.save(); }
  if (fu.next_due > t) return;
  if (fu.last_sent && t - fu.last_sent < MIN_GAP) { fu.next_due = fu.last_sent + MIN_GAP; await r.S.save(); return; }
  const dayLog = (fu.sent_log || []).filter((x: number) => t - x < 86400);
  if (fu.creator_id !== DB(r).owner && dayLog.length >= MAX_PER_DAY) { fu.next_due = Math.min(...dayLog) + 86400 + 60; await r.S.save(); return; }
  await C.refreshName(r, fu);
  const asVoice = C.wantVoice(r, fu);
  const [txt, model] = await C.genFollowup(r, fu, asVoice);
  let wasVoice = asVoice;
  try { const m = await C.sendToTarget(r, fu, txt, asVoice); wasVoice = !!m.voice; }
  catch (e) {
    log("send failed", fu.id, String(e));
    fu.status = "paused"; await r.S.save();
    await C.notify(r, fu.creator_id, `⚠️ ارسال پیگیری #${fa(fu.id)} ناموفق بود (شاید بلاک شدم یا از گروه انداختنم). متوقفش کردم. خطا: ${(e as Error).message || e}`);
    return;
  }
  fu.sent_count = (fu.sent_count || 0) + 1;
  fu.last_sent = now();
  fu.sent_log = [...dayLog, fu.last_sent].slice(-10);
  fu.history = [...(fu.history || []), txt].slice(-8);
  let note = "";
  if (fu.max_count && fu.sent_count >= fu.max_count) { fu.status = "paused"; note = "\n(به سقف تعداد رسید و متوقف شد؛ /resume برای ادامه)"; }
  fu.next_due = C.computeNext(fu);
  await r.S.save();
  log("sent", fu.id, fu.sent_count, model, wasVoice ? "voice" : "text");
  if (fu.mode !== "group" || note) {
    if (!fu.self) await C.notify(r, fu.creator_id, `📤 پیگیری #${fa(fu.id)} برای ${fu.name} رفت (پیام ${fa(fu.sent_count)}${asVoice ? "، 🎙 ویس" : ""}):\n\n${txt}${note}`);
  }
}
