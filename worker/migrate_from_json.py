#!/usr/bin/env python3
"""Convert the Python bot's data.json into SQL for D1 (writes .migrate/data.sql, mode 600)."""
import json, sys, os
src = sys.argv[1] if len(sys.argv) > 1 else "../data.json"
out = sys.argv[2] if len(sys.argv) > 2 else ".migrate/data.sql"
bot_username = sys.argv[3] if len(sys.argv) > 3 else ""
d = json.load(open(src, encoding="utf-8"))
def q(v):
    if v is None: return "NULL"
    if isinstance(v, bool): return "1" if v else "0"
    if isinstance(v, (int, float)): return repr(v)
    return "'" + str(v).replace("'", "''") + "'"
L = [f"DELETE FROM {t};" for t in ["followups","usernames","started","banned","names","tg_names","name_mem","translit","groups","members","chat_state"]]
kv = {"owner": d.get("owner"), "next_id": d.get("next_id", 1), "voice_prob": d.get("voice_prob", 0.28),
      "voice_style": d.get("voice_style", "AB"), "bot_username": bot_username or None}
for k, v in kv.items():
    L.append(f"INSERT INTO kv (k, v) VALUES ({q(k)}, {q(None if v is None else str(v))}) ON CONFLICT(k) DO UPDATE SET v = excluded.v;")
# gender fixes (Hamed: «طلا» is a girl's name)
FEMALE_GIVEN = {"طلا"}
n = {"followups": 0}
for fid, f in d.get("followups", {}).items():
    if f.get("name") in FEMALE_GIVEN or (f.get("target_username") or "") == "tala_ap":
        f["gender"] = "female"; f["gender_source"] = "given"
    L.append("INSERT OR REPLACE INTO followups (id, code, status, creator_id, target_chat_id, next_due, data) VALUES "
             f"({int(fid)}, {q(f.get('code'))}, {q(f.get('status'))}, {q(f.get('creator_id'))}, {q(f.get('target_chat_id'))}, {q(f.get('next_due'))}, {q(json.dumps(f, ensure_ascii=False))});")
    n["followups"] += 1
for u, cid in d.get("users", {}).items(): L.append(f"INSERT OR REPLACE INTO usernames (username, chat_id) VALUES ({q(u)}, {q(cid)});")
for uid in d.get("started", []): L.append(f"INSERT OR IGNORE INTO started (uid) VALUES ({q(uid)});")
for uid in d.get("banned", []): L.append(f"INSERT OR IGNORE INTO banned (uid) VALUES ({q(uid)});")
for uid, nm in d.get("names", {}).items(): L.append(f"INSERT OR REPLACE INTO names (uid, name) VALUES ({int(uid)}, {q(nm)});")
for uid, nm in d.get("tg_names", {}).items(): L.append(f"INSERT OR REPLACE INTO tg_names (uid, first) VALUES ({int(uid)}, {q(nm)});")
for k, v in d.get("name_mem", {}).items(): L.append(f"INSERT OR REPLACE INTO name_mem (k, name, source) VALUES ({q(k)}, {q(v.get('name'))}, {q(v.get('source'))});")
for k, v in d.get("translit", {}).items(): L.append(f"INSERT OR REPLACE INTO translit (k, name) VALUES ({q(k)}, {q(v)});")
nm = 0
for gid, g in d.get("groups", {}).items():
    L.append(f"INSERT OR REPLACE INTO groups (chat_id, title) VALUES ({int(gid)}, {q(g.get('title'))});")
    for uid, m in (g.get("members") or {}).items():
        L.append(f"INSERT OR REPLACE INTO members (chat_id, uid, first, last, username, seen) VALUES ({int(gid)}, {int(uid)}, {q(m.get('first',''))}, {q(m.get('last',''))}, {q(m.get('username',''))}, {q(int(m.get('seen',0)))});")
        nm += 1
os.makedirs(os.path.dirname(out) or ".", exist_ok=True)
with open(out, "w", encoding="utf-8") as fh: fh.write("\n".join(L) + "\n")
os.chmod(out, 0o600)
print(json.dumps({"followups": n["followups"], "usernames": len(d.get("users", {})), "started": len(d.get("started", [])),
                  "banned": len(d.get("banned", [])), "names": len(d.get("names", {})), "tg_names": len(d.get("tg_names", {})),
                  "name_mem": len(d.get("name_mem", {})), "translit": len(d.get("translit", {})), "groups": len(d.get("groups", {})),
                  "members": nm, "statements": len(L)}))
