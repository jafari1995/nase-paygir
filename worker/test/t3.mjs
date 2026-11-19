import { send, tick, db, mf, OWNER } from "./harness.mjs";
const show = (label, cs) => { console.log(`\n=== ${label}`); for (const c of cs) console.log(`  [${c.method}] chat=${c.chat_id ?? ""} ${(c.text || c.caption || "").replace(/\n/g, " ⏎ ").slice(0, 230)}`); };
const PV = (u) => ({ id: u.id, type: "private" });
const G = { id: -1003723790282, type: "supergroup", title: "تست" };
const MINA = { id: 222, is_bot: false, first_name: "Mina", username: "mina_x" };
show("group chatter mina", await send(MINA, G, "سلام"));
show("create for mina in group", await send(OWNER, G, "ناصر مینا ۲۰۰ تومن بهم بدهکاره، یادش بنداز"));
show("mina answers", await send(MINA, G, "ناصر بابا فردا میدم", {}));
// fu 5 tala: tick
const f5 = JSON.parse((await db.prepare("SELECT data FROM followups WHERE id=5").first()).data);
console.log("fu5", f5.name, f5.gender, f5.gender_source, f5.status, f5.mode);
f5.next_due = 1; f5.last_sent = 1; await db.prepare("UPDATE followups SET data=?, next_due=1 WHERE id=5").bind(JSON.stringify(f5)).run();
await db.prepare("UPDATE kv SET v='0' WHERE k='voice_prob'").run();
show("tick tala", await tick());
show("override gender", await send(OWNER, PV(OWNER), "ناصر عباس خانمه"));
const f7 = JSON.parse((await db.prepare("SELECT data FROM followups WHERE id=7").first()).data); console.log("fu7", f7.name, f7.gender, f7.gender_source);
await mf.dispose();
