-- Naser Paygir D1 schema
CREATE TABLE IF NOT EXISTS kv (k TEXT PRIMARY KEY, v TEXT);
CREATE TABLE IF NOT EXISTS followups (id INTEGER PRIMARY KEY, code TEXT, status TEXT, creator_id INTEGER, target_chat_id INTEGER, next_due REAL, data TEXT NOT NULL);
CREATE INDEX IF NOT EXISTS fu_due ON followups(status, next_due);
CREATE INDEX IF NOT EXISTS fu_code ON followups(code);
CREATE TABLE IF NOT EXISTS usernames (username TEXT PRIMARY KEY, chat_id INTEGER);
CREATE TABLE IF NOT EXISTS started (uid INTEGER PRIMARY KEY);
CREATE TABLE IF NOT EXISTS banned (uid INTEGER PRIMARY KEY);
CREATE TABLE IF NOT EXISTS names (uid INTEGER PRIMARY KEY, name TEXT);
CREATE TABLE IF NOT EXISTS tg_names (uid INTEGER PRIMARY KEY, first TEXT);
CREATE TABLE IF NOT EXISTS name_mem (k TEXT PRIMARY KEY, name TEXT, source TEXT);
CREATE TABLE IF NOT EXISTS translit (k TEXT PRIMARY KEY, name TEXT);
CREATE TABLE IF NOT EXISTS groups (chat_id INTEGER PRIMARY KEY, title TEXT);
CREATE TABLE IF NOT EXISTS members (chat_id INTEGER, uid INTEGER, first TEXT, last TEXT, username TEXT, seen INTEGER, PRIMARY KEY (chat_id, uid));
CREATE TABLE IF NOT EXISTS chat_state (k TEXT PRIMARY KEY, v TEXT, ts REAL);
CREATE TABLE IF NOT EXISTS seen_updates (update_id INTEGER PRIMARY KEY, ts REAL);
INSERT OR IGNORE INTO kv (k, v) VALUES ('next_id', '1'), ('voice_prob', '0.28'), ('voice_style', 'AB'), ('tick_lock', '0');
