import { send, mf, OWNER } from "./harness.mjs";
const cs = await send(OWNER, { id: OWNER.id, type: "private" }, "ناصر سلام خوبی؟");
console.log(cs.map(c => c.method + " " + (c.text || "").slice(0, 200)));
await mf.dispose();
