// D1-backed state. Mirrors the Python JSON "DB" dict in memory; save() diffs against the
// loaded snapshot and writes only changed rows (row-level upserts, so concurrent updates
// to different users / follow-ups don't clobber each other).
export type Member = { first: string; last: string; username: string; seen: number };
export type FU = Record<string, any>;
export type DBT = {
  owner: number | null; voice_prob: number; voice_style: string; bot_username: string;
  followups: Record<string, FU>; users: Record<string, number>; started: number[]; banned: number[];
  names: Record<string, string>; tg_names: Record<string, string>;
  name_mem: Record<string, { name: string; source: string | null }>; translit: Record<string, string>;
  groups: Record<string, { title: string | null; members: Record<string, Member> }>;
};

const J = JSON.stringify;

export class Store {
  db: D1Database; d!: DBT; snap: Record<string, Record<string, string>> = {};
  constructor(db: D1Database) { this.db = db; }

  static async load(db: D1Database, onlyDue?: number): Promise<Store> {
    const s = new Store(db);
    const fuq = onlyDue === undefined
      ? db.prepare("SELECT id, data FROM followups ORDER BY id")
      : db.prepare("SELECT id, data FROM followups ORDER BY id");
    const rs = await db.batch([
      db.prepare("SELECT k, v FROM kv"), fuq,
      db.prepare("SELECT username, chat_id FROM usernames"), db.prepare("SELECT uid FROM started"),
      db.prepare("SELECT uid FROM banned"), db.prepare("SELECT uid, name FROM names"),
      db.prepare("SELECT uid, first FROM tg_names"), db.prepare("SELECT k, name, source FROM name_mem"),
      db.prepare("SELECT k, name FROM translit"), db.prepare("SELECT chat_id, title FROM groups"),
      db.prepare("SELECT chat_id, uid, first, last, username, seen FROM members"),
    ]);
    const R = (i: number) => (rs[i].results || []) as any[];
    const kv: Record<string, string> = {}; for (const r of R(0)) kv[r.k] = r.v;
    const d: DBT = {
      owner: kv.owner ? Number(kv.owner) : null, voice_prob: kv.voice_prob ? Number(kv.voice_prob) : 0.28,
      voice_style: kv.voice_style || "AB", bot_username: kv.bot_username || "",
      followups: {}, users: {}, started: [], banned: [], names: {}, tg_names: {}, name_mem: {}, translit: {}, groups: {},
    };
    for (const r of R(1)) d.followups[String(r.id)] = JSON.parse(r.data);
    for (const r of R(2)) d.users[r.username] = Number(r.chat_id);
    for (const r of R(3)) d.started.push(Number(r.uid));
    for (const r of R(4)) d.banned.push(Number(r.uid));
    for (const r of R(5)) d.names[String(r.uid)] = r.name;
    for (const r of R(6)) d.tg_names[String(r.uid)] = r.first;
    for (const r of R(7)) d.name_mem[r.k] = { name: r.name, source: r.source ?? null };
    for (const r of R(8)) d.translit[r.k] = r.name;
    for (const r of R(9)) d.groups[String(r.chat_id)] = { title: r.title, members: {} };
    for (const r of R(10)) {
      const g = (d.groups[String(r.chat_id)] ||= { title: null, members: {} });
      g.members[String(r.uid)] = { first: r.first || "", last: r.last || "", username: r.username || "", seen: Number(r.seen) || 0 };
    }
    s.d = d; s.snapshot();
    return s;
  }

  private views(): Record<string, Record<string, string>> {
    const d = this.d, v: Record<string, Record<string, string>> = {};
    v.kv = { owner: J(d.owner), voice_prob: J(d.voice_prob), voice_style: J(d.voice_style), bot_username: J(d.bot_username) };
    v.followups = {}; for (const [k, f] of Object.entries(d.followups)) v.followups[k] = J(f);
    v.usernames = {}; for (const [k, x] of Object.entries(d.users)) v.usernames[k] = J(x);
    v.started = {}; for (const x of d.started) v.started[String(x)] = "1";
    v.banned = {}; for (const x of d.banned) v.banned[String(x)] = "1";
    v.names = {}; for (const [k, x] of Object.entries(d.names)) v.names[k] = J(x);
    v.tg_names = {}; for (const [k, x] of Object.entries(d.tg_names)) v.tg_names[k] = J(x);
    v.name_mem = {}; for (const [k, x] of Object.entries(d.name_mem)) v.name_mem[k] = J(x);
    v.translit = {}; for (const [k, x] of Object.entries(d.translit)) v.translit[k] = J(x);
    v.groups = {}; v.members = {};
    for (const [gid, g] of Object.entries(d.groups)) {
      v.groups[gid] = J(g.title);
      for (const [uid, m] of Object.entries(g.members || {})) v.members[`${gid}|${uid}`] = J(m);
    }
    return v;
  }
  snapshot() { this.snap = this.views(); }

  async save() {
    const now = this.views(), db = this.db, st: D1PreparedStatement[] = [];
    for (const [tbl, cur] of Object.entries(now)) {
      const old = this.snap[tbl] || {};
      for (const [k, v] of Object.entries(cur)) {
        if (old[k] === v) continue;
        const x = JSON.parse(v);
        switch (tbl) {
          case "kv": st.push(db.prepare("INSERT INTO kv (k, v) VALUES (?, ?) ON CONFLICT(k) DO UPDATE SET v = excluded.v").bind(k, x === null ? null : String(x))); break;
          case "followups": st.push(db.prepare("INSERT INTO followups (id, code, status, creator_id, target_chat_id, next_due, data) VALUES (?, ?, ?, ?, ?, ?, ?) ON CONFLICT(id) DO UPDATE SET code=excluded.code, status=excluded.status, creator_id=excluded.creator_id, target_chat_id=excluded.target_chat_id, next_due=excluded.next_due, data=excluded.data")
            .bind(Number(k), x.code ?? null, x.status ?? null, x.creator_id ?? null, x.target_chat_id ?? null, x.next_due ?? null, v)); break;
          case "usernames": st.push(db.prepare("INSERT INTO usernames (username, chat_id) VALUES (?, ?) ON CONFLICT(username) DO UPDATE SET chat_id = excluded.chat_id").bind(k, x)); break;
          case "started": st.push(db.prepare("INSERT OR IGNORE INTO started (uid) VALUES (?)").bind(Number(k))); break;
          case "banned": st.push(db.prepare("INSERT OR IGNORE INTO banned (uid) VALUES (?)").bind(Number(k))); break;
          case "names": st.push(db.prepare("INSERT INTO names (uid, name) VALUES (?, ?) ON CONFLICT(uid) DO UPDATE SET name = excluded.name").bind(Number(k), x)); break;
          case "tg_names": st.push(db.prepare("INSERT INTO tg_names (uid, first) VALUES (?, ?) ON CONFLICT(uid) DO UPDATE SET first = excluded.first").bind(Number(k), x)); break;
          case "name_mem": st.push(db.prepare("INSERT INTO name_mem (k, name, source) VALUES (?, ?, ?) ON CONFLICT(k) DO UPDATE SET name = excluded.name, source = excluded.source").bind(k, x.name, x.source ?? null)); break;
          case "translit": st.push(db.prepare("INSERT INTO translit (k, name) VALUES (?, ?) ON CONFLICT(k) DO UPDATE SET name = excluded.name").bind(k, x)); break;
          case "groups": st.push(db.prepare("INSERT INTO groups (chat_id, title) VALUES (?, ?) ON CONFLICT(chat_id) DO UPDATE SET title = excluded.title").bind(Number(k), x)); break;
          case "members": { const [gid, uid] = k.split("|");
            st.push(db.prepare("INSERT INTO members (chat_id, uid, first, last, username, seen) VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT(chat_id, uid) DO UPDATE SET first=excluded.first, last=excluded.last, username=excluded.username, seen=excluded.seen")
              .bind(Number(gid), Number(uid), x.first, x.last, x.username, x.seen)); break; }
        }
      }
      for (const k of Object.keys(old)) {
        if (k in cur) continue;
        switch (tbl) {
          case "followups": st.push(db.prepare("DELETE FROM followups WHERE id = ?").bind(Number(k))); break;
          case "usernames": st.push(db.prepare("DELETE FROM usernames WHERE username = ?").bind(k)); break;
          case "started": st.push(db.prepare("DELETE FROM started WHERE uid = ?").bind(Number(k))); break;
          case "banned": st.push(db.prepare("DELETE FROM banned WHERE uid = ?").bind(Number(k))); break;
          case "names": st.push(db.prepare("DELETE FROM names WHERE uid = ?").bind(Number(k))); break;
          case "tg_names": st.push(db.prepare("DELETE FROM tg_names WHERE uid = ?").bind(Number(k))); break;
          case "name_mem": st.push(db.prepare("DELETE FROM name_mem WHERE k = ?").bind(k)); break;
          case "translit": st.push(db.prepare("DELETE FROM translit WHERE k = ?").bind(k)); break;
          case "groups": st.push(db.prepare("DELETE FROM groups WHERE chat_id = ?").bind(Number(k))); break;
          case "members": { const [gid, uid] = k.split("|"); st.push(db.prepare("DELETE FROM members WHERE chat_id = ? AND uid = ?").bind(Number(gid), Number(uid))); break; }
        }
      }
    }
    if (st.length) await db.batch(st);
    this.snap = now;
  }

  async nextId(): Promise<number> {
    const r = await this.db.prepare("UPDATE kv SET v = CAST(CAST(v AS INTEGER) + 1 AS TEXT) WHERE k = 'next_id' RETURNING v").first<{ v: string }>();
    return Number(r!.v) - 1;
  }
  async getState<T = any>(k: string): Promise<T | null> {
    const r = await this.db.prepare("SELECT v FROM chat_state WHERE k = ?").bind(k).first<{ v: string }>();
    return r ? JSON.parse(r.v) : null;
  }
  async setState(k: string, v: any) {
    if (v === null || v === undefined) { await this.db.prepare("DELETE FROM chat_state WHERE k = ?").bind(k).run(); return; }
    await this.db.prepare("INSERT INTO chat_state (k, v, ts) VALUES (?, ?, ?) ON CONFLICT(k) DO UPDATE SET v = excluded.v, ts = excluded.ts").bind(k, J(v), Date.now() / 1000).run();
  }
}
