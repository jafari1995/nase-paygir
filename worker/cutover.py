#!/usr/bin/env python3
"""Cutover helper (box). Reads TELEGRAM_BOT_TOKEN from env and never prints it.
  python3 cutover.py check        # worker has its secrets? (TTS self-test via derived secret)
  python3 cutover.py stop-python  # stop the box polling bot (run.sh loop + bot.py)
  python3 cutover.py set-webhook  # point Telegram at the Worker (secret_token = derived)
  python3 cutover.py verify       # getWebhookInfo summary (url host, pending, last error)
  python3 cutover.py rollback     # deleteWebhook + restart the Python bot (../start.sh)
"""
import hashlib, json, os, subprocess, sys, urllib.request, urllib.parse
URL = "https://naser-paygir.bibigolnar.workers.dev"
TOK = os.environ["TELEGRAM_BOT_TOKEN"].strip()
SECRET = hashlib.sha256(("naser-webhook:" + TOK).encode()).hexdigest()[:48]
def tg(method, **p):
    data = urllib.parse.urlencode({k: (json.dumps(v) if isinstance(v, (list, dict)) else v) for k, v in p.items()}).encode()
    return json.load(urllib.request.urlopen(f"https://api.telegram.org/bot{TOK}/{method}", data=data, timeout=30))
cmd = sys.argv[1] if len(sys.argv) > 1 else "check"
if cmd == "check":
    req = urllib.request.Request(URL + "/selftest/tts", headers={"X-Selftest-Token": SECRET, "User-Agent": "naser-cutover/1.0"})
    try:
        r = urllib.request.urlopen(req, timeout=60); b = r.read()
        open("/tmp/naser_selftest.mp3", "wb").write(b)
        print("worker OK: secrets set; TTS", r.headers.get("x-engine"), f"{len(b)} bytes, {r.headers.get('x-duration')}s -> /tmp/naser_selftest.mp3")
    except urllib.error.HTTPError as e:
        print("worker not ready:", e.code, "(403 = TELEGRAM_BOT_TOKEN secret missing or different; 502 = TTS failed)")
elif cmd == "stop-python":
    subprocess.run(["pkill", "-f", "followup-bot/run.sh"]); subprocess.run(["pkill", "-f", "python3 -u /workspace/followup-bot/bot.py"])
    print("python bot stopped" if subprocess.run(["pgrep", "-f", "followup-bot/bot.py"], capture_output=True).returncode else "WARNING: still running")
elif cmd == "set-webhook":
    r = tg("setWebhook", url=URL + "/telegram", secret_token=SECRET, allowed_updates=["message", "callback_query", "my_chat_member"], drop_pending_updates="false", max_connections=20)
    print("setWebhook:", r.get("ok"), r.get("description"))
    tg("setMyCommands", commands=[{"command": c, "description": d} for c, d in [("new", "پیگیری جدید"), ("list", "لیست پیگیری‌ها"), ("test", "پیام نمونه"), ("pause", "توقف"), ("resume", "ادامه"), ("done", "تموم شد"), ("delete", "حذف"), ("link", "لینک طرف"), ("help", "راهنما")]])
elif cmd == "verify":
    w = tg("getWebhookInfo")["result"]
    print({"url_host": urllib.parse.urlparse(w.get("url", "")).netloc, "pending": w.get("pending_update_count"), "last_error": w.get("last_error_message"), "allowed_updates": w.get("allowed_updates")})
elif cmd == "rollback":
    print("deleteWebhook:", tg("deleteWebhook").get("ok"))
    subprocess.run(["/workspace/followup-bot/start.sh"])
