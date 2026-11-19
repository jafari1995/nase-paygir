import { send, cb, tick, db, mf, OWNER, calls } from "./harness.mjs";
const show = (label, cs) => { console.log(`\n=== ${label}`); for (const c of cs) console.log(`  [${c.method}] chat=${c.chat_id ?? ""} ${(c.text || c.caption || c.voice || c.action || "").toString().replace(/\n/g, " ⏎ ").slice(0, 200)}${c.reply_markup ? " KB" : ""}${c.duration ? " dur=" + c.duration : ""}`); };
const PV = (u) => ({ id: u.id, type: "private", first_name: u.first_name });
const ALI = { id: 111222333, is_bot: false, first_name: "Ali", username: "ali_k" };
const BOB = { id: 999888777, is_bot: false, first_name: "Bob", username: "bobby" };
// make Ali a started user with an active private fu from owner
show("ali start", await send(ALI, PV(ALI), "/start"));
show("owner creates for @ali_k", await send(OWNER, PV(OWNER), "ناصر @ali_k اسمش علیه، ۵۰۰ تومن بدهکاره. با ویس یادش بنداز"));
const f = await db.prepare("SELECT id, data FROM followups ORDER BY id DESC LIMIT 1").first(); const fd = JSON.parse(f.data);
console.log("fu", f.id, fd.name, fd.status, fd.voice, fd.target_chat_id);
for (let i = 1; i <= 5; i++) show(`ali stop #${i}`, await send(ALI, PV(ALI), "مزاحم نشو دیگه"));
console.log("status after 5:", JSON.parse((await db.prepare("SELECT data FROM followups WHERE id=?").bind(f.id).first()).data).status);
// Bob (another user) cannot see/manage owner's fus
show("bob list", await send(BOB, PV(BOB), "/list"));
show("bob /pause 1", await send(BOB, PV(BOB), "/pause 1"));
show("bob cb cdone:1", await cb(BOB, PV(BOB), "cdone:1", 77));
show("bob /all", await send(BOB, PV(BOB), "/all"));
// wizard
show("wiz new", await send(BOB, PV(BOB), "/new"));
show("wiz name", await send(BOB, PV(BOB), "رضا"));
show("wiz subj", await send(BOB, PV(BOB), "کتاب"));
show("wiz amount", await send(BOB, PV(BOB), "-"));
show("wiz sched", await send(BOB, PV(BOB), "هر ۲ ساعت"));
show("wiz max", await send(BOB, PV(BOB), "۳"));
show("wiz target", await send(BOB, PV(BOB), "لینک"));
// tick: force voice on fu #2 (active) by making it due
await db.prepare("UPDATE kv SET v='1' WHERE k='voice_prob'").run();
const f2 = JSON.parse((await db.prepare("SELECT data FROM followups WHERE id=2").first()).data);
f2.next_due = 1; f2.last_sent = 1; f2.status = "active";
await db.prepare("UPDATE followups SET data=?, next_due=1, status='active' WHERE id=2").bind(JSON.stringify(f2)).run();
show("tick", await tick());
show("tick again (nothing due)", await tick());
// owner confirms paid via callback on fu 9? use owner /done flow on fu 2
show("owner /done 2", await send(OWNER, PV(OWNER), "/done 2"));
show("owner cb thx:2", await cb(OWNER, PV(OWNER), "thx:2", 78));
show("voiceprob", await send(OWNER, PV(OWNER), "/voiceprob 28"));
// self reminder + done
show("self create", await send(BOB, PV(BOB), "ناصر یادم بنداز امروز کتاب بخونم"));
show("self done", await send(BOB, PV(BOB), "انجام دادم"));
await mf.dispose();
