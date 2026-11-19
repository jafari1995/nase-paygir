#!/usr/bin/env python3
"""ربات پیگیر — Telegram follow-up / debt-collector bot (owner-managed)."""
import os, re, json, time, random, secrets, logging, asyncio, html
from datetime import datetime, timedelta
from zoneinfo import ZoneInfo
import httpx
from telegram import Update, InlineKeyboardButton, InlineKeyboardMarkup
from telegram.constants import ParseMode
from telegram.ext import (Application, CommandHandler, MessageHandler, ConversationHandler,
                          CallbackQueryHandler, ContextTypes, filters)

BASE = os.path.dirname(os.path.abspath(__file__))
DATA = os.path.join(BASE, "data.json")
TZ = ZoneInfo("Asia/Tehran")
MIN_GAP = 3600  # at least 1 hour between messages per follow-up
TOKEN = os.environ["TELEGRAM_BOT_TOKEN"].strip()
_raw = os.environ.get("OPENROUTER_API_KEY", "")
_m = re.search(r"sk-or-v1-[0-9a-fA-F]{20,}", _raw)
OR_KEY = _m.group(0) if _m else _raw.strip()
MODELS = ["baidu/ernie-5.5-flash-preview:free", "google/gemma-4-31b-it:free",
          "nvidia/nemotron-3-ultra-550b-a55b:free", "google/gemma-4-26b-a4b-it:free"]

# --- HARD GUARD: free models only (Hamed: never use paid models) ---
MODELS = [m for m in MODELS if m.endswith(":free")]
FREE_ONLY = {"provider": {"max_price": {"prompt": 0, "completion": 0, "request": 0, "image": 0}}}
def free_model(m):
    if not str(m).endswith(":free"):
        logging.getLogger("followup").error("BLOCKED non-free model id: %s", m); return False
    return True
def free_response(j, model):
    """Reject a response that was served by a non-free model or cost anything."""
    served = str(j.get("model") or model)
    cost = ((j.get("usage") or {}).get("cost") or 0)
    if not served.endswith(":free") or cost:
        logging.getLogger("followup").error("DISCARDED non-free response: model=%s cost=%s", served, cost); return False
    return True

logging.basicConfig(format="%(asctime)s %(levelname)s %(name)s: %(message)s", level=logging.INFO)
logging.getLogger("httpx").setLevel(logging.WARNING)
logging.getLogger("apscheduler").setLevel(logging.WARNING)
log = logging.getLogger("followup")

# ---------------- storage ----------------
def load():
    if os.path.exists(DATA):
        with open(DATA, encoding="utf-8") as f:
            return json.load(f)
    return {"owner": None, "next_id": 1, "followups": {}, "users": {}}

def save(db):
    tmp = DATA + ".tmp"
    with open(tmp, "w", encoding="utf-8") as f:
        json.dump(db, f, ensure_ascii=False, indent=1)
    os.chmod(tmp, 0o600)
    os.replace(tmp, DATA)

DB = load()
if "started" not in DB: DB["started"] = list(set(DB.get("users", {}).values()))
for _f in DB["followups"].values():
    _f.setdefault("creator_id", DB.get("owner")); _f.setdefault("creator_name", "حامد")
DB.setdefault("banned", []); DB.setdefault("names", {})
MAX_ACTIVE = 5; MAX_PER_DAY = 5; LLM_PER_HOUR = 20
DB.setdefault("voice_prob", 0.28)
import voice as V
DB.setdefault("voice_style", "AB"); V.STYLE = DB["voice_style"]
VOICE_RE = re.compile(r"(با\s*ویس|ویس\s*(بده|بفرست|بگو)|صوتی|وویس)")
NOVOICE_RE = re.compile(r"(بدون\s*ویس|ویس\s*نده|ویس\s*نفرست|متنی)")
def want_voice(fu=None):
    mode = (fu or {}).get("voice", "auto")
    if mode == "always": return True
    if mode == "never": return False
    return random.random() < float(DB.get("voice_prob", 0.28))

FA_DIGITS = str.maketrans("۰۱۲۳۴۵۶۷۸۹٠١٢٣٤٥٦٧٨٩", "01234567890123456789")
def norm(s): return (s or "").translate(FA_DIGITS).strip()
def fa(n): return str(n).translate(str.maketrans("0123456789", "۰۱۲۳۴۵۶۷۸۹"))
def is_owner(u): return DB["owner"] is not None and u.id == DB["owner"]
is_admin = is_owner
def is_banned(uid): return uid in DB.get("banned", [])
def can_manage(uid, fu): return uid == DB.get("owner") or fu.get("creator_id") == uid
def own_fus(uid, include_all_for_admin=False):
    return [f for f in DB["followups"].values() if f.get("creator_id") == uid or (include_all_for_admin and uid == DB.get("owner"))]
def in_scope(fu, chat):
    """Group output may only ever include that group's own (non-self) follow-ups."""
    if chat is None or chat.type == "private": return True
    return fu.get("mode") == "group" and fu.get("target_chat_id") == chat.id and not fu.get("self")
def scoped(fus, chat): return [f for f in fus if in_scope(f, chat)]
def where_label(fu):
    if fu.get("mode") == "group" and fu.get("target_chat_id"):
        t = DB.get("groups", {}).get(str(fu["target_chat_id"]), {}).get("title") or "گروه"
        return f"👥 گروه «{t}»"
    return "🔒 پیوی" + (" (یادآور شخصی)" if fu.get("self") else "")
def open_count(uid): return sum(1 for f in own_fus(uid) if f["status"] in ("pending", "active", "paused"))
_llm_hits = {}
def llm_allowed(uid):
    if uid == DB.get("owner"): return True
    h = [t for t in _llm_hits.get(uid, []) if time.time() - t < 3600]
    if len(h) >= LLM_PER_HOUR: _llm_hits[uid] = h; return False
    h.append(time.time()); _llm_hits[uid] = h; return True
def cname(u): return (u.first_name or u.username or "رفیق")[:30]
def clamp_schedule(s, uid):
    """non-admins: at most MAX_PER_DAY messages/day."""
    if uid == DB.get("owner") or not s: return s, ""
    if s["type"] == "times" and len(s["times"]) > MAX_PER_DAY:
        return {"type": "times", "times": spread_per_day(MAX_PER_DAY)}, f"\n(سقف روزی {fa(MAX_PER_DAY)} پیامه، همون {fa(MAX_PER_DAY)} بار گذاشتم.)"
    if s["type"] == "interval" and s["hours"] < 24 / MAX_PER_DAY:
        return {"type": "interval", "hours": 24 / MAX_PER_DAY}, f"\n(سقف روزی {fa(MAX_PER_DAY)} پیامه، فاصله رو کردم {fa(24/MAX_PER_DAY)} ساعت.)"
    return s, ""


# ---------------- schedule ----------------
def parse_schedule(text):
    t = norm(text)
    times = re.findall(r"(\d{1,2})[:٫.](\d{2})", t)
    if times:
        out = sorted({f"{int(h):02d}:{int(m):02d}" for h, m in times if int(h) < 24 and int(m) < 60})
        return {"type": "times", "times": out} if out else None
    m = re.search(r"(\d+(?:\.\d+)?)\s*(ساعت|hour|h|روز|day|d)", t, re.I)
    if m:
        n = float(m.group(1)); unit = m.group(2).lower()
        hours = n * 24 if unit in ("روز", "day", "d") else n
        return {"type": "interval", "hours": max(1.0, hours)}
    if re.search(r"(روزی|هر روز|daily)", t):
        return {"type": "interval", "hours": 24.0}
    return None

def sched_text(s):
    if s["type"] == "times": return "هر روز ساعت " + "، ".join(fa(x) for x in s["times"]) + " (تهران)"
    h = s["hours"]; h = int(h) if float(h).is_integer() else h
    return f"هر {fa(int(h/24) if h % 24 == 0 else h)} {'روز' if h % 24 == 0 else 'ساعت'}"

def compute_next(fu, now=None):
    now = max(now or time.time(), fu.get("skip_until") or 0)
    last = fu.get("last_sent") or 0
    s = fu["schedule"]
    if s["type"] == "interval":
        base = last + s["hours"] * 3600 if last else now + 60
    else:
        dt = datetime.fromtimestamp(now, TZ)
        base = None
        for d in range(0, 3):
            day = (dt + timedelta(days=d)).date()
            for hm in s["times"]:
                h, m = map(int, hm.split(":"))
                cand = datetime(day.year, day.month, day.day, h, m, tzinfo=TZ).timestamp()
                if cand > now and cand >= last + MIN_GAP:
                    base = cand; break
            if base: break
        base = base or now + 86400
    return max(base, last + MIN_GAP if last else base)

# ---------------- LLM ----------------
SYSTEM = """تو یه «پیگیرِ» حرفه‌ای هستی که از طرف «حامد» پیام پیگیری می‌نویسی.
سبک: فارسی محاوره‌ای تهرونی، لوتی‌منش و داش‌مشتی (مرام، معرفت، قول مردونه)، یه کم محکم و زمخت ولی بامزه و حاضرجواب، با چاشنی طنز و تیکه‌های لوتی.
قوانین قطعی:
- حتماً اسم طرف و موضوع رو بیار؛ مبلغ و جزئیات رو دقیقاً همون‌طور که داده شده بنویس و عوضش نکن.
- ۱ تا ۴ جمله، کوتاه و تاثیرگذار. فقط متن پیام، بدون توضیح، بدون گیومه، بدون عنوان.
- هر بار کاملاً متفاوت از پیام‌های قبلی بنویس (شروع، تیکه و شوخی تکراری ممنوع).
- هیچ تهدید به خشونت یا آسیب، هیچ فحش و توهین، هیچ حرفی درباره‌ی خانواده‌ی طرف، هیچ آبروریزی یا تهدید به افشا. محکم باش ولی محترم و لوتی.
- به اندازه‌ی «سطح پیگیری» کم‌کم جدی‌تر شو (ولی همیشه با شوخی)."""

LEVELS = ["خیلی نرم و رفیقانه، یادآوری دوستانه", "رفیقانه ولی یه کم جدی‌تر",
          "جدی‌تر، با تیکه‌ی لوتی درباره‌ی قول و مرام", "محکم و پیگیر، با شوخیِ تند ولی محترم",
          "خیلی پیگیر و کلافه‌ی بامزه، رو قول مردونه تاکید کن"]

def level_for(n): return LEVELS[min(n // 2, len(LEVELS) - 1)]

def clean(txt):
    txt = re.sub(r"<think>.*?</think>", "", txt or "", flags=re.S).strip().strip('"«»“”').strip()
    txt = re.sub(r"[\u00C0-\u024F\u0400-\u04FF\u4e00-\u9fff]+", "", txt).replace("أ", "ا")
    txt = txt.replace("**", "").replace("__", "").strip().strip('"«»“”').strip()
    return txt[:900]

async def llm(messages, max_tokens=500):
    async with httpx.AsyncClient(timeout=60) as c:
        for model in MODELS:
            if not free_model(model): continue
            try:
                r = await c.post("https://openrouter.ai/api/v1/chat/completions",
                                 headers={"Authorization": f"Bearer {OR_KEY}",
                                          "HTTP-Referer": "https://t.me/naser_paygir_bot", "X-Title": "Paygir Bot"},
                                 json={"model": model, "messages": messages, "max_tokens": max_tokens + 1200, "temperature": 1.0, "reasoning": {"effort": "low", "exclude": True}, **FREE_ONLY})
                j = r.json()
                if r.status_code == 200 and j.get("choices") and free_response(j, model):
                    txt = clean(j["choices"][0]["message"].get("content"))
                    if txt and re.search(r"[\u0600-\u06FF]", txt):
                        return txt, model
                log.warning("model %s failed: %s %s", model, r.status_code, str((j.get("error") or {}).get("message", "no-text/empty"))[:120])
            except Exception as e:
                log.warning("model %s error: %s", model, e)
    return None, None

FALLBACK = ["{name} جان، این {subject} هنوز رو زمین مونده ها! مرد و قولش، یه خبری بده داداش.",
            "سلام {name}، ما هنوز منتظر {subject}یم. لوتی‌گری به اینه که آدم زیر قولش نزنه، نه؟ 😄",
            "{name} داداش، {subject} یادت نرفته که؟ ما که یادمون نمیره! منتظر خبرتیم.",
            "آقا {name}، بازم ماییم و {subject}. یه زحمت بکش تکلیفشو روشن کن، معرفتت رو نشون بده."]

def subj(fu):
    return fu["subject"] + (f" ({fu['amount']})" if fu.get("amount") else "")

SELF_SYSTEM = """تو «ناصر» هستی، رفیقِ لوتی‌منش و سمجِ خودِ این آدم که ازت خواسته یادش بندازی کارش/هدفش رو انجام بده.
سبک: فارسی محاوره‌ای تهرونی، داش‌مشتی، مثل یه رفیق زمخت ولی دلسوز که غر می‌زنه و تیکه می‌ندازه تا طرف تنبلی نکنه؛ بامزه و حاضرجواب.
قوانین: اسمش (دقیقاً همون‌طور که داده شده، اگه لاتینه فارسیِ درستش رو بنویس) و کارش رو بیار؛ ۱ تا ۳ جمله؛ هر بار متفاوت؛ این بدهی نیست، کار/هدف خودشه (مگه اینکه موضوع بدهیِ خودش به کسی باشه)؛ بدون توهین و تحقیر، فقط تشویقِ لوتی‌وار و غرغر بامزه. فقط متن پیام."""

async def gen_followup(fu, voice=False):
    n = fu.get("sent_count", 0)
    prev = fu.get("history", [])[-5:]
    user = (f"اسم طرف: {fu['name']} (فقط با همین اسم صداش کن؛ هیچ‌وقت یوزرنیم یا آیدی یا @ ننویس)\nموضوع: {subj(fu)}\n"
            + ("توضیحات/زمینه از طرف صاحب‌کار (ازشون استفاده کن): " + " | ".join(fu.get("notes", [])[-5:]) + "\n" if fu.get("notes") else "")
            + f"شماره‌ی این پیام پیگیری: {n+1}\n"
            f"سطح پیگیری: {level_for(n)}\n")
    if prev:
        user += "پیام‌های قبلی (اینا رو تکرار نکن):\n" + "\n".join(f"- {p}" for p in prev)
    if voice:
        user += f"\nاین پیام قراره ویس (صوتی) بشه: حداکثر {V.MAX_WORDS} کلمه، ۱-۲ جمله‌ی کوتاه و گفتاری، بدون ایموجی و علامت عجیب، مثل اینکه داری با صدای لوتی پشت تلفن حرف می‌زنی."
        if V.STYLE != "orig": user += "\n" + V.SPOKEN_HINT
    sysm = SELF_SYSTEM if fu.get("self") else SYSTEM.replace("حامد", fu.get("creator_name") or "رفیقم")
    if fu.get("self"): user = user.replace("اسم طرف:", "اسم خودش:").replace("موضوع:", "کار/هدفش:") + ("\n(کار تکراری/عادت روزانه)" if fu.get("recurring") else "")
    txt, model = await llm([{"role": "system", "content": sysm}, {"role": "user", "content": user}])
    if not txt:
        txt = random.choice(FALLBACK).format(name=fu["name"], subject=subj(fu)); model = "template"
    return scrub_ids(txt, fu), model

async def gen_thanks(fu):
    txt, _ = await llm([{"role": "system", "content": "به فارسی محاوره‌ای و لوتی‌منش، یه پیام تشکر کوتاه (۱-۲ جمله) و بامزه بنویس چون طرف بدهی/خواسته‌اش رو انجام داده. فقط متن پیام."},
                        {"role": "user", "content": f"اسم: {fu['name']}\nموضوع: {subj(fu)}"}], 200)
    return txt or f"{fu['name']} جان دمت گرم! بابت {subj(fu)} مرسی، معرفتت رو نشون دادی 🌹"

# ---------------- helpers ----------------
HELP = """🧾 <b>ناصر، پیگیرِ لوتی — راهنما</b>

👥 هر کسی می‌تونه از من استفاده کنه و پیگیری خودش رو بسازه؛ هر کی فقط پیگیری‌های خودش رو می‌بینه.

💬 لازم نیست دستور بزنی؛ همین‌جوری بنویس، مثلاً:
«ناصر @reza پولمو نمیده روزی ۵ بار یادش بنداز»
«ناصر رضا رو فعلاً ول کن» / «ناصر لیست» / «ناصر رضا پولو داد»
تو گروه هم اسم «ناصر» رو بیاری می‌فهمم.

دستورهای کمکی:
/new — ساخت پیگیری جدید (قدم‌به‌قدم)
/list — لیست پیگیری‌ها
/link &lt;id&gt; — دوباره گرفتن لینک مخصوص طرف
/test &lt;id&gt; — یه پیام نمونه فقط برای خودت
/pause &lt;id&gt; — توقف موقت
/resume &lt;id&gt; — ادامه
/done &lt;id&gt; — تموم شد (با گزینه‌ی پیام تشکر)
/delete &lt;id&gt; — حذف
/cancel — لغو ساخت پیگیری
🎙 بعضی وقتا ویس می‌دم! بگی «با ویس یادش بنداز» همیشه ویس می‌دم، «بدون ویس» یعنی فقط متن.
/stop — (برای کسی که ازش پیگیری می‌شه) «مزاحم نشو» 😏

⏱ حداقل فاصله‌ی بین دو پیام: ۱ ساعت؛ حداکثر ۵ پیگیری باز و روزی ۵ پیام برای هر پیگیری.
📌 تلگرام اجازه نمی‌ده ربات اول به کسی پیام بده؛ پس لینک مخصوص هر پیگیری رو برای طرف بفرست تا یه بار Start بزنه. از اون به بعد ربات خودش پیگیری می‌کنه و جواب‌هاش رو برات می‌فرسته."""

STATUS = {"pending": "⏳ منتظر استارت طرف", "active": "▶️ فعال", "paused": "⏸ متوقف", "done": "✅ تموم‌شده", "stopped": "🚫 طرف کنسلش کرد"}

def list_text(fus, chat):
    if chat is not None and chat.type != "private":
        return "\n\n".join(fu_line(f, public=True) for f in scoped(fus, chat))
    groups = {}
    for f in fus: groups.setdefault(where_label(f), []).append(f)
    return "\n\n".join(f"<b>{html.escape(k)}</b>\n" + "\n\n".join(fu_line(f) for f in v) for k, v in groups.items())

def deep_link(ctx, fu): return f"https://t.me/{ctx.bot.username}?start={fu['code']}"

def fu_line(fu, public=False):
    nxt = ""
    if fu["status"] == "active" and fu.get("next_due"):
        nxt = "\nپیام بعدی: " + fa(datetime.fromtimestamp(fu["next_due"], TZ).strftime("%m/%d %H:%M"))
    mx = f" از {fa(fu['max_count'])}" if fu.get("max_count") else ""
    tag = f" (@{html.escape(fu['target_username'])})" if fu.get("target_username") else ""
    nts = ("\n📝 " + html.escape(" | ".join(fu["notes"][-3:]))) if (fu.get("notes") and not public) else ""
    return (f"<b>#{fa(fu['id'])}</b> {html.escape(fu['name'])}{tag} — {html.escape(subj(fu))}{nts}\n"
            f"{STATUS[fu['status']]} | {sched_text(fu['schedule'])} | ارسال‌شده: {fa(fu.get('sent_count',0))}{mx}{nxt}")

def get_fu(arg):
    try: return DB["followups"].get(str(int(norm(arg))))
    except Exception: return None

def activate(fu, chat_id):
    fu["target_chat_id"] = chat_id; fu["status"] = "active"
    fu["next_due"] = compute_next(fu)

def admin_only(fn):
    async def wrap(update, ctx):
        if not is_admin(update.effective_user): return
        if update.effective_chat.type != "private" and fn.__name__ != "all_cmd":
            await update.effective_message.reply_text("دستورهای مدیریتی فقط تو پیوی 🔒"); return
        return await fn(update, ctx)
    return wrap

def owner_only(fn):
    async def wrap(update: Update, ctx: ContextTypes.DEFAULT_TYPE):
        if is_banned(update.effective_user.id):
            return ConversationHandler.END
        return await fn(update, ctx)
    return wrap

def remember_user(u, chat_id):
    if u.username:
        DB["users"][u.username.lower()] = chat_id

# ---------------- handlers ----------------
async def start(update: Update, ctx: ContextTypes.DEFAULT_TYPE):
    u = update.effective_user; chat = update.effective_chat.id
    remember_user(u, chat)
    if update.effective_chat.type != "private":
        return
    mark_started(u.id)
    code = ctx.args[0] if ctx.args else None
    if code:
        fu = next((f for f in DB["followups"].values() if f.get("code") == code), None)
        if fu and fu["status"] in ("pending", "active", "paused") and (fu.get("target_chat_id") in (None, chat)):
            if fu.get("self") and u.id != fu.get("creator_id"):
                save(DB); await update.message.reply_text("این لینک معتبر نیست یا منقضی شده."); return
            if u.id == fu.get("creator_id") and not fu.get("self"):
                save(DB); await update.message.reply_text("این لینک مال طرف مقابله، نه خودت 😄 بفرستش براش.")
                return
            was_pending = fu["status"] == "pending"
            fu["target_chat_id"] = chat
            fu["target_user_id"] = u.id; fu["mode"] = "private"
            if u.first_name: DB["tg_names"][str(u.id)] = u.first_name
            if u.username and not fu.get("target_username"): fu["target_username"] = u.username.lower()
            await refresh_name(fu)
            if was_pending: activate(fu, chat)
            save(DB)
            cn = fu.get("creator_name") or "رفیقم"
            await update.message.reply_text(f"سلام {fu['name']} 👋\nمن ناصرم، پیگیرِ {cn}. یه سری پیام درباره‌ی «{subj(fu)}» برات می‌فرستم. هر جوابی بدی مستقیم به {cn} می‌رسه.")
            await notify(ctx.bot, fu["creator_id"], f"🔔 طرفِ پیگیری #{fa(fu['id'])} ({html.escape(fu['name'])}) ربات رو استارت کرد"
                                       f"{' (@'+html.escape(u.username)+')' if u.username else ''}. پیگیری فعال شد.", parse_mode=ParseMode.HTML)
            return
        save(DB)
        await update.message.reply_text("این لینک معتبر نیست یا منقضی شده.")
        return
    if DB["owner"] is None:
        DB["owner"] = u.id; save(DB)
        await update.message.reply_text("✅ تو الان صاحب این رباتی.\n\n" + HELP, parse_mode=ParseMode.HTML)
        return
    save(DB)
    if is_banned(u.id): return
    DB["names"][str(u.id)] = cname(u); save(DB)
    await update.message.reply_text(f"سلام {html.escape(cname(u))} 👋 من ناصرم، پیگیرِ لوتی. هر کی ازت طلب داره یا قولی داده و یادش رفته، بسپرش به من.\n\n" + HELP, parse_mode=ParseMode.HTML)

@owner_only
async def help_cmd(update, ctx):
    await update.message.reply_text(HELP, parse_mode=ParseMode.HTML)

NAME, SUBJECT, AMOUNT, SCHED, MAXC, TARGET = range(6)

@owner_only
async def new(update, ctx):
    u = update.effective_user
    if update.effective_chat.type != "private":
        await update.message.reply_text("ساخت قدم‌به‌قدم فقط تو پیوی 🔒 — تو گروه بنویس «ناصر فلانی ...»"); return ConversationHandler.END
    if not is_admin(u) and open_count(u.id) >= MAX_ACTIVE:
        await update.message.reply_text(f"داداش {fa(MAX_ACTIVE)} تا پیگیری باز داری، سقفش همینه. یکی رو /done یا /delete کن."); return ConversationHandler.END
    ctx.user_data["new"] = {}
    await update.message.reply_text("👤 اسم طرف چیه؟ (همونی که تو پیام صداش می‌زنیم)\n/cancel برای لغو")
    return NAME

async def s_name(update, ctx):
    ctx.user_data["new"]["name"] = update.message.text.strip()[:60]
    await update.message.reply_text("📝 موضوع چیه؟ (مثلاً: پول قرضی، کتابی که برده، کاری که قول داده)")
    return SUBJECT

async def s_subject(update, ctx):
    ctx.user_data["new"]["subject"] = update.message.text.strip()[:200]
    await update.message.reply_text("💰 مبلغ؟ (مثلاً ۲ میلیون تومن) — اگه مبلغ نداره بنویس «-»")
    return AMOUNT

async def s_amount(update, ctx):
    t = update.message.text.strip()
    ctx.user_data["new"]["amount"] = None if t in ("-", "—", "ندارد", "نه") else t[:60]
    await update.message.reply_text("⏱ هر چند وقت پیگیری کنم؟ نمونه‌ها:\n• «هر ۶ ساعت»\n• «هر ۲ روز»\n• «۱۰:۰۰ و ۱۸:۳۰» (ساعت‌های ثابت روزانه به وقت تهران)\nحداقل فاصله ۱ ساعته.")
    return SCHED

async def s_sched(update, ctx):
    s = parse_schedule(update.message.text)
    if not s:
        await update.message.reply_text("متوجه نشدم 😅 یه چیزی مثل «هر ۸ ساعت» یا «هر ۱ روز» یا «۱۰:۰۰، ۲۰:۰۰» بنویس.")
        return SCHED
    s, _note = clamp_schedule(s, update.effective_user.id)
    ctx.user_data["new"]["schedule"] = s
    await update.message.reply_text(f"باشه: {sched_text(s)}.\n🔢 حداکثر چند تا پیام بفرستم؟ (عدد) — بی‌نهایت تا وقتی /done بزنی: «-»")
    return MAXC

async def s_max(update, ctx):
    t = norm(update.message.text)
    ctx.user_data["new"]["max_count"] = int(t) if t.isdigit() and int(t) > 0 else None
    await update.message.reply_text("🎯 طرف کیه؟\n• اگه قبلاً ربات رو استارت کرده، یوزرنیمش رو بفرست (مثلاً @reza)\n• وگرنه بنویس «لینک» تا یه لینک مخصوص بدم که براش بفرستی.")
    return TARGET

async def s_target(update, ctx):
    t = update.message.text.strip()
    d = ctx.user_data.pop("new", {})
    fid = DB["next_id"]; DB["next_id"] += 1
    fu = {"id": fid, **d, "code": "f" + secrets.token_urlsafe(9).replace("-", "x").replace("_", "y"),
          "status": "pending", "target_chat_id": None, "target_username": None, "sent_count": 0,
          "history": [], "last_sent": None, "next_due": None, "created": time.time(),
          "creator_id": update.effective_user.id, "creator_name": cname(update.effective_user), "mode": "private"}
    msg = ""
    await first_creation_notice(ctx.bot, update.effective_user)
    if t.startswith("@"):
        uname = t[1:].lower(); fu["target_username"] = uname
        cid = DB["users"].get(uname)
        if cid:
            activate(fu, cid); msg = f"✅ @{html.escape(uname)} پیدا شد، پیگیری فعال شد."
        else:
            msg = f"⚠️ @{html.escape(uname)} هنوز ربات رو استارت نکرده. این لینک رو براش بفرست:"
    else:
        msg = "🔗 این لینک رو برای طرف بفرست. وقتی Start بزنه پیگیری خودکار شروع می‌شه و خبرت می‌کنم:"
    DB["followups"][str(fid)] = fu; save(DB)
    if fu["status"] == "pending":
        msg += f"\n{deep_link(ctx, fu)}"
    await update.message.reply_text(msg + "\n\n" + fu_line(fu) + f"\n\nنمونه پیام: /test {fid}",
                                    parse_mode=ParseMode.HTML, disable_web_page_preview=True)
    return ConversationHandler.END

async def cancel(update, ctx):
    ctx.user_data.pop("new", None)
    await update.message.reply_text("لغو شد.")
    return ConversationHandler.END

@owner_only
async def list_cmd(update, ctx):
    fus = scoped(own_fus(update.effective_user.id), update.effective_chat)
    if not fus and update.effective_chat.type != "private":
        await update.message.reply_text("تو این گروه پیگیری‌ای نداری. بقیه‌ش رو تو پیوی ببین 🔒"); return
    if not fus:
        await update.message.reply_text("هنوز پیگیری‌ای نداری. بنویس مثلاً «ناصر @reza پولمو نمیده روزی ۳ بار یادش بنداز» یا /new"); return
    await update.message.reply_text(list_text(fus, update.effective_chat), parse_mode=ParseMode.HTML)

async def _need(update, ctx):
    fu = get_fu(ctx.args[0]) if ctx.args else None
    if fu and not can_manage(update.effective_user.id, fu): fu = None
    if fu and not in_scope(fu, update.effective_chat): fu = None
    if not fu: await update.message.reply_text("شماره‌ی پیگیری رو درست بده، مثلاً: /pause 1  (لیست: /list)")
    return fu

@owner_only
async def pause(update, ctx):
    fu = await _need(update, ctx)
    if not fu: return
    if fu["status"] != "active":
        await update.message.reply_text("این پیگیری الان فعال نیست."); return
    fu["status"] = "paused"; save(DB)
    await update.message.reply_text(f"⏸ پیگیری #{fa(fu['id'])} متوقف شد.")

@owner_only
async def resume(update, ctx):
    fu = await _need(update, ctx)
    if not fu: return
    if fu["status"] != "paused":
        await update.message.reply_text("این پیگیری متوقف نیست."); return
    if not is_admin(update.effective_user) and open_count(fu["creator_id"]) > MAX_ACTIVE:
        await update.message.reply_text("سقف پیگیری‌های باز پره."); return
    if fu.get("target_chat_id"):
        fu["status"] = "active"; fu["next_due"] = compute_next(fu)
    else:
        fu["status"] = "pending"
    save(DB)
    await update.message.reply_text("▶️ ادامه پیدا کرد.\n" + fu_line(fu, public=update.effective_chat.type != "private"), parse_mode=ParseMode.HTML)

@owner_only
async def delete(update, ctx):
    fu = await _need(update, ctx)
    if not fu: return
    del DB["followups"][str(fu["id"])]; save(DB)
    await update.message.reply_text(f"🗑 پیگیری #{fa(fu['id'])} حذف شد.")

@owner_only
async def link(update, ctx):
    fu = await _need(update, ctx)
    if not fu: return
    await update.message.reply_text(deep_link(ctx, fu), disable_web_page_preview=True)

@owner_only
async def test(update, ctx):
    fu = await _need(update, ctx)
    if not fu: return
    await update.message.reply_text("⏳ دارم می‌نویسم...")
    txt, model = await gen_followup(fu)
    await update.message.reply_text(f"🧪 نمونه (فقط برای تو، برای طرف نرفت):\n\n{txt}\n\n— مدل: {model}")

@owner_only
async def done(update, ctx):
    fu = await _need(update, ctx)
    if not fu: return
    fu["status"] = "done"; save(DB)
    kb = None
    if fu.get("target_chat_id"):
        kb = InlineKeyboardMarkup([[InlineKeyboardButton("🌹 بفرست پیام تشکر", callback_data=f"thx:{fu['id']}"),
                                    InlineKeyboardButton("نه", callback_data=f"nothx:{fu['id']}")]])
    await update.message.reply_text(f"✅ پیگیری #{fa(fu['id'])} تموم شد و دیگه پیامی نمی‌ره." + ("\nبراش پیام تشکر بفرستم؟" if kb else ""), reply_markup=kb)

async def on_cb(update, ctx):
    q = update.callback_query
    act, fid = q.data.split(":")
    fu = DB["followups"].get(fid)
    if not fu or not can_manage(q.from_user.id, fu):
        await q.answer(); return
    await q.answer()
    if act == "thx" and fu and fu.get("target_chat_id"):
        txt = await gen_thanks(fu)
        await ctx.bot.send_message(fu["target_chat_id"], txt)
        await q.edit_message_text(f"✅ پیگیری #{fa(fid)} تموم شد. پیام تشکر رفت:\n\n{txt}")
    else:
        await q.edit_message_text(f"✅ پیگیری #{fa(fid)} تموم شد.")

# ================= Naser: conversational layer + groups =================
from naser import OWNER_SYS, TARGET_SYS, OTHER_SYS, spread_per_day, extract_json
from telegram.constants import ChatType

def _nz(s):
    s = (s or "").lower().replace("ي", "ی").replace("ك", "ک").replace("\u200c", " ").replace("ـ", "")
    return re.sub(r"\s+", " ", s).strip().lstrip("@")

def is_group(chat): return chat.type in (ChatType.GROUP, ChatType.SUPERGROUP)

from naser import spread_per_day as _spd
DB.setdefault("name_mem", {}); DB.setdefault("tg_names", {}); DB.setdefault("translit", {})
DB["name_mem"] = {k: v for k, v in DB["name_mem"].items() if k.startswith("c") or v.get("source") != "given"}
NAME_RANK = {"given": 3, "telegram": 2, "username": 1, None: 0}
def has_fa(x): return bool(re.search(r"[\u0600-\u06FF]", x or ""))
def _mkeys(uid, uname, creator=None):
    ks = ([f"u:{uid}"] if uid else []) + ([f"@{uname}"] if uname else [])
    return [f"c{creator}:{k}" for k in ks] if creator else ks
def mem_get(uid=None, uname=None, creator=None):
    for k in (_mkeys(uid, uname, creator) if creator else []) + _mkeys(uid, uname):
        v = DB["name_mem"].get(k)
        if v and (k.startswith("c") or v.get("source") != "given"): return v
    return None
def mem_put(uid, uname, name, source, creator=None):
    # names a creator typed stay private to that creator; Telegram/username-derived names are shared
    for k in _mkeys(uid, uname, creator if source == "given" else None):
        old = DB["name_mem"].get(k)
        if not old or NAME_RANK.get(source, 0) >= NAME_RANK.get(old.get("source"), 0):
            DB["name_mem"][k] = {"name": name, "source": source}
async def to_fa_name(raw):
    raw = (raw or "").strip().lstrip("@")
    if not raw: return None
    if has_fa(raw): return re.sub(r"[^\u0600-\u06FF\u200c ]", "", raw).strip()[:30] or None
    key = raw.lower()
    if key in DB["translit"]: return DB["translit"][key]
    txt, _ = await llm([{"role": "system", "content": "تو یه مترجم اسم هستی. یه اسم یا یوزرنیم لاتین بهت می‌دن؛ اسم کوچیکِ فارسیِ درستش رو بنویس (مثلاً Reza→رضا، Mohammad→محمد، mmd_r→محمد، ali.k→علی، Sara→سارا، Hamed→حامد). اگه اسم آدم نیست یا معلوم نیست، فقط بنویس: رفیق. فقط خودِ اسم، بدون هیچ توضیح."},
                        {"role": "user", "content": raw}], 30)
    name = re.sub(r"[^\u0600-\u06FF\u200c ]", "", txt or "").strip()
    if not name or len(name) > 20 or len(name.split()) > 2: name = "رفیق"
    DB["translit"][key] = name; save(DB)
    return name
def tg_first(uid):
    if not uid: return None
    if str(uid) in DB["tg_names"]: return DB["tg_names"][str(uid)]
    for g in DB.get("groups", {}).values():
        m = g["members"].get(str(uid))
        if m and m.get("first"): return m["first"]
    return None
async def resolve_display(uid, uname, given, creator=None):
    """Pick the best display name: given > remembered > telegram first_name > username guess."""
    if given and not given.strip().startswith("@") and _nz(given) != _nz(uname or ""):
        n = await to_fa_name(given)
        if n and n != "رفیق": mem_put(uid, uname, n, "given", creator); return n, "given"
    m = mem_get(uid, uname, creator)
    if m and m.get("source") == "given": return m["name"], "given"
    first = tg_first(uid)
    if first:
        n = await to_fa_name(first)
        if n: mem_put(uid, uname, n, "telegram"); return n, "telegram"
    if m: return m["name"], m.get("source")
    if uname:
        n = await to_fa_name((re.split(r"[\d_.\-]+", uname)[0] or uname))
        mem_put(uid, uname, n, "username"); return n, "username"
    return (given or "رفیق"), "given" if given else None
async def refresh_name(fu):
    """Upgrade a guessed name once we learn more (e.g. their Telegram first name)."""
    if fu.get("self"):
        if not has_fa(fu.get("name")):
            n = await to_fa_name(fu.get("name"))
            if n and n != "رفیق": fu["name"] = n; save(DB)
        return
    if NAME_RANK.get(fu.get("name_source"), 0) >= 3: return
    n, src = await resolve_display(fu.get("target_user_id"), fu.get("target_username"), None, fu.get("creator_id"))
    if n and NAME_RANK.get(src, 0) > NAME_RANK.get(fu.get("name_source"), 0):
        fu["name"], fu["name_source"] = n, src; save(DB)
def scrub_ids(txt, fu):
    """Never address the person by @username / raw id in the body."""
    t = re.sub(r"@\w+", fu["name"], txt or "")
    un = fu.get("target_username")
    if un: t = re.sub(re.escape(un), fu["name"], t, flags=re.I)
    if fu.get("target_user_id"): t = t.replace(str(fu["target_user_id"]), "")
    return re.sub(r"\s{2,}", " ", t).strip()

for _f in DB["followups"].values():
    if "name_source" not in _f or (_f.get("name_source") == "username" and not has_fa(_f.get("name"))):
        _f["name_source"] = "given" if has_fa(_f.get("name")) else None

def mark_started(uid):
    st = DB.setdefault("started", [])
    if uid not in st: st.append(uid)

def register_member(chat, u):
    if u is not None and not u.is_bot and u.first_name: DB["tg_names"][str(u.id)] = u.first_name
    if not chat or not is_group(chat) or u is None or u.is_bot: return
    g = DB.setdefault("groups", {}).setdefault(str(chat.id), {"title": chat.title, "members": {}})
    g["title"] = chat.title
    old = g["members"].get(str(u.id), {})
    new = {"first": u.first_name or "", "last": u.last_name or "", "username": (u.username or "").lower(), "seen": int(time.time())}
    if {k: old.get(k) for k in ("first", "last", "username")} != {k: new[k] for k in ("first", "last", "username")} or time.time() - old.get("seen", 0) > 3600:
        g["members"][str(u.id)] = new; save(DB)

def members(chat_id):
    return DB.get("groups", {}).get(str(chat_id), {}).get("members", {})

def mname(m): return (m["first"] + " " + m["last"]).strip() or m["username"]

def code_match(chat_id, name):
    q = _nz(name); out = []
    if not q: return out
    for uid, m in members(chat_id).items():
        fields = [_nz(m["first"]), _nz(m["last"]), _nz(mname(m)), _nz(m["username"])]
        if any(f and (f == q or q in f.split() or (len(q) >= 3 and (q in f or f in q))) for f in fields):
            out.append(int(uid))
    return out

def mention_html(fu):
    if fu.get("mode") == "group":
        if fu.get("target_user_id"):
            return f'<a href="tg://user?id={fu["target_user_id"]}">{html.escape(fu["name"])}</a> '
        if fu.get("target_username"):
            return f'@{html.escape(fu["target_username"])} '
    return ""

async def send_voice_or_text(bot, chat_id, txt, caption_html=None, reply_to=None, force_voice=False):
    """Try a voice note; fall back to text. Returns (message, was_voice)."""
    if force_voice:
        ogg, engine, spoken = await V.synth(txt)
        if ogg:
            try:
                with open(ogg, "rb") as f:
                    m = await bot.send_voice(chat_id, f, caption=caption_html or None, parse_mode=ParseMode.HTML if caption_html else None,
                                             duration=int(V.duration(ogg) or 0) or None, reply_to_message_id=reply_to)
                log.info("voice sent via %s (%d words)", engine, len(spoken.split()))
                return m, True
            except Exception as e:
                log.warning("send_voice failed: %s", e)
            finally:
                try: os.remove(ogg)
                except Exception: pass
    m = await bot.send_message(chat_id, (caption_html or "") + html.escape(txt), parse_mode=ParseMode.HTML, reply_to_message_id=reply_to)
    return m, False

async def send_to_target(bot, fu, txt, voice=False):
    m, _ = await send_voice_or_text(bot, fu["target_chat_id"], txt, caption_html=mention_html(fu) or None, force_voice=voice)
    fu["bot_msg_ids"] = (fu.get("bot_msg_ids", []) + [m.message_id])[-30:]
    return m

async def notify(bot, uid, text, fu=None, **kw):
    if not uid: return
    if fu is not None and fu.get("self"): return
    try: await bot.send_message(uid, text, **kw)
    except Exception as e: log.warning("notify %s failed: %s", uid, e)

async def notify_owner(bot, text, **kw):
    await notify(bot, DB.get("owner"), text, **kw)

async def first_creation_notice(bot, u):
    if u.id == DB.get("owner") or own_fus(u.id): return
    who = html.escape(u.full_name or "") + (f" @{html.escape(u.username)}" if u.username else "")
    await notify_owner(bot, f"🆕 کاربر جدید اولین پیگیریش رو ساخت: {who} (id: <code>{u.id}</code>)\nبرای بستنش: /ban {u.id}", parse_mode=ParseMode.HTML)

async def llm_json(system, user, max_tokens=700):
    msgs = [{"role": "system", "content": system}, {"role": "user", "content": user}]
    async with httpx.AsyncClient(timeout=90) as c:
        for model in MODELS + MODELS[:2]:
            if not free_model(model): continue
            try:
                r = await c.post("https://openrouter.ai/api/v1/chat/completions",
                                 headers={"Authorization": f"Bearer {OR_KEY}", "X-Title": "Paygir Bot"},
                                 json={"model": model, "messages": msgs, "max_tokens": max_tokens + 1500, "temperature": 0.5, "reasoning": {"effort": "low", "exclude": True}, **FREE_ONLY})
                j = r.json()
                if r.status_code == 200 and j.get("choices") and free_response(j, model):
                    d = extract_json(j["choices"][0]["message"].get("content"))
                    if isinstance(d, dict): return d, model
                log.warning("json model %s failed: %s %s", model, r.status_code, str((j.get("error") or {}).get("message", "no-json/empty"))[:120])
                if r.status_code == 429: await asyncio.sleep(1.5)
            except Exception as e:
                log.warning("json model %s error: %s", model, e)
    return None, None

def fus_brief(uid, chat=None):
    rows = []
    for f in scoped(own_fus(uid, include_all_for_admin=(chat is None or chat.type == "private")), chat):
        if f["status"] == "done" and time.time() - f.get("created", 0) > 7*86400: continue
        where = "گروه" if f.get("mode") == "group" else "پیوی"
        rows.append(("" if f.get("creator_id") == uid else f"[مال {f.get('creator_name')}] ") + f"#{f['id']} | {f['name']} | @{f.get('target_username') or '-'} | {subj(f)} | {STATUS[f['status']]} | {where} | {sched_text(f['schedule'])}")
    return "\n".join(rows) or "(هیچی)"

def hist_get(ctx, uid=None): return ctx.chat_data.setdefault(f"naser_hist_{uid}", [])
def hist_add(ctx, role, text, uid=None):
    h = hist_get(ctx, uid); h.append(f"{role}: {text}"); del h[:-10]

async def build_owner_prompt(update, ctx, text):
    chat = update.effective_chat; msg = update.effective_message; me = update.effective_user; nm = cname(me)
    p = f"نوع چت: {'گروه «'+(chat.title or '')+'»' if is_group(chat) else 'پیوی با '+nm}\n"
    p += f"زمان الان (تهران): {datetime.now(TZ).strftime('%Y-%m-%d %H:%M')}\n"
    p += "پیگیری‌های موجود:\n" + fus_brief(me.id, chat) + "\n"
    if not is_admin(me): p += f"محدودیت این کاربر: حداکثر روزی {MAX_PER_DAY} پیام برای هر پیگیری (اگه بیشتر خواست، تو reply بگو سقفش روزی {MAX_PER_DAY} باره) و حداکثر {MAX_ACTIVE} پیگیری باز.\n"
    if is_group(chat):
        p += "مهم: این گفتگو تو گروهه؛ فقط درباره‌ی پیگیری‌های همین گروه که بالا اومده حرف بزن و هیچ‌وقت از پیگیری‌های خصوصی یا پیوی حرفی نزن.\n"
        ms = sorted(members(chat.id).items(), key=lambda kv: -kv[1].get("seen", 0))[:80]
        p += "اعضای دیده‌شده‌ی این گروه (user_id | اسم | یوزرنیم):\n" + "\n".join(
            f"{uid} | {mname(m)} | @{m['username'] or '-'}" + (f" (خودِ {nm} که داره باهات حرف می‌زنه)" if int(uid) == me.id else "") for uid, m in ms) + "\n"
        p += 'اگه طرف یکی از این اعضاست، یه فیلد اضافه هم بده: "target_user_ids": [آیدی‌های عددیِ اعضای محتمل] (با درنظر گرفتن فینگلیش/فارسی و اسم کوچیک). اگه هیچکی نخورد [] بذار.\n'
        p += 'فیلد "delivery": "private" اگه گفت پیوی/خصوصی بهش پیام بده، وگرنه "group".\n'
        p += 'برای create یه فیلد "first_line" هم بده: یه تیکه‌ی لوتی و بامزه‌ی ۱ جمله‌ای خطاب به خود طرف درباره‌ی موضوع، که با اسم واقعیش (display_name یا اسم کوچیکش، نه یوزرنیم) صداش کنه؛ هیچ‌وقت @ یا یوزرنیم ننویس.\n'
    rt = msg.reply_to_message
    if rt and rt.from_user and not rt.from_user.is_bot and rt.from_user.id != me.id:
        p += f"{nm} روی پیام این آدم ریپلای کرده: {rt.from_user.full_name} (@{rt.from_user.username or '-'})\n"
    h = hist_get(ctx, me.id)
    if h: p += "تاریخچه‌ی گفتگوی اخیر:\n" + "\n".join(h) + "\n"
    p += f"\nپیام جدید {nm}: {text}"
    return p

def find_fu(d, uid, chat=None):
    mine = scoped(own_fus(uid, include_all_for_admin=(chat is None or chat.type == "private")), chat)
    if d.get("id"):
        f = DB["followups"].get(str(norm(str(d["id"]))))
        if f and f in mine: return [f]
    own = [f for f in mine if f.get("creator_id") == uid] or mine
    cands = [f for f in own if f["status"] not in ("done", "stopped")] or own
    out = []
    un = _nz(d.get("target_username")); nm = _nz(d.get("target_name"))
    for f in cands:
        if un and _nz(f.get("target_username")) == un: out.append(f)
        elif nm and (nm in _nz(f["name"]) or _nz(f["name"]) in nm): out.append(f)
    return out

def norm_schedule(s):
    if not isinstance(s, dict): return None
    t = s.get("type")
    try:
        if t == "per_day": return {"type": "times", "times": spread_per_day(int(norm(str(s.get("count") or 1))))}
        if t == "interval": return {"type": "interval", "hours": max(1.0, float(norm(str(s.get("hours")))))}
        if t == "times":
            ts = parse_schedule(" ".join(s.get("times") or []))
            return ts if ts and ts["type"] == "times" else None
    except Exception: return None
    return None

def new_fu(**kw):
    # creator fields must be passed in by caller
    fid = DB["next_id"]; DB["next_id"] += 1
    fu = {"id": fid, "code": "f" + secrets.token_urlsafe(9).replace("-", "x").replace("_", "y"),
          "status": "pending", "target_chat_id": None, "target_username": None, "target_user_id": None,
          "mode": "private", "sent_count": 0, "history": [], "convo": [], "last_sent": None,
          "next_due": None, "created": time.time(), "amount": None, "max_count": None}
    fu.update(kw); DB["followups"][str(fid)] = fu
    return fu

async def owner_reply(update, ctx, text, **kw):
    hist_add(ctx, "ناصر", re.sub(r"<[^>]+>", "", text)[:300], update.effective_user.id)
    return await update.effective_message.reply_text(text, parse_mode=ParseMode.HTML, disable_web_page_preview=True, **kw)

async def handle_owner(update: Update, ctx: ContextTypes.DEFAULT_TYPE, text: str):
    chat = update.effective_chat; msg = update.effective_message; me = update.effective_user
    if not llm_allowed(me.id):
        if time.time() - _rl_warned.get(me.id, 0) > 600:
            _rl_warned[me.id] = time.time()
            await msg.reply_text("داداش یه نفس بگیر 😅 ساعتی ۲۰ تا پیام بیشتر نمی‌تونم جواب بدم. یه کم دیگه بیا، یا از /list و /pause استفاده کن.")
        return
    DB["names"][str(me.id)] = cname(me)
    await ctx.bot.send_chat_action(chat.id, "typing")
    prompt = await build_owner_prompt(update, ctx, text)
    hist_add(ctx, cname(me), text, me.id)
    d, model = await llm_json(OWNER_SYS.replace("حامد", cname(me)), prompt)
    log.info("intent from user %s via %s: action=%s", me.id, model, (d or {}).get("action"))
    if not d:
        await owner_reply(update, ctx, "داداش یه لحظه سیم‌هام قاطی شد 😅 یه بار دیگه بگو، یا از دستورها مثل /new و /list استفاده کن.")
        return
    act = (d.get("action") or "chat").lower()
    rep = html.escape(d.get("reply") or "")
    vpref = "always" if VOICE_RE.search(text) else ("never" if NOVOICE_RE.search(text) else None)
    ctx.chat_data[f"vpref_{me.id}"] = vpref
    if act in ("chat", "clarify"):
        if vpref == "always" or (act == "chat" and random.random() < float(DB.get("voice_prob", 0.28)) / 2):
            short = d.get("reply") or "جانم داداش؟"
            if len(short.split()) > V.MAX_WORDS:
                t2, _ = await llm([{"role": "system", "content": "این متن رو با همون لحن لوتی، حداکثر ۲۵ کلمه و گفتاری خلاصه کن. فقط متن."}, {"role": "user", "content": short}], 150)
                short = t2 or short
            m, ok = await send_voice_or_text(ctx.bot, chat.id, short, reply_to=msg.message_id, force_voice=True)
            hist_add(ctx, "ناصر", short, me.id); return
        await owner_reply(update, ctx, rep or "جانم داداش؟"); return
    if act == "list":
        fus = scoped(own_fus(me.id), chat)
        body = list_text(fus, chat) or ("تو این گروه پیگیری‌ای نداری؛ بقیه رو تو پیوی ببین 🔒" if is_group(chat) else "فعلاً کسی تو لیست نیست.")
        await owner_reply(update, ctx, (rep + "\n\n" if (rep and fus) else "") + body); return
    if act == "create":
        await do_create(update, ctx, d, rep); return
    # actions on an existing follow-up
    fs = find_fu(d, me.id, chat)
    if not fs:
        await owner_reply(update, ctx, "کدوم پیگیری داداش؟ شماره یا اسمش رو بگو.\n\n" + (list_text(scoped(own_fus(me.id), chat), chat) or "فعلاً پیگیری‌ای نداری" + (" (تو این گروه)." if is_group(chat) else "."))); return
    if len(fs) > 1:
        await owner_reply(update, ctx, "چند تا جور درمیاد، کدومش؟\n\n" + "\n\n".join(fu_line(f, public=is_group(chat)) for f in fs)); return
    fu = fs[0]
    if vpref and act in ("edit", "resume", "test"):
        fu["voice"] = vpref; save(DB)
        rep += " 🎙 ویس: " + ("همیشه" if vpref == "always" else "خاموش")
    if act == "edit":
        s = norm_schedule(d.get("schedule"))
        if s:
            s, cnote = clamp_schedule(s, fu["creator_id"]); fu["schedule"] = s
            rep += html.escape(cnote)
        for k in ("subject", "amount"):
            if d.get(k): fu[k] = str(d[k])[:200]
        if d.get("display_name") and not str(d["display_name"]).startswith("@"):
            nn = await to_fa_name(str(d["display_name"]))
            if nn and nn != "رفیق":
                fu["name"], fu["name_source"] = nn, "given"; mem_put(fu.get("target_user_id"), fu.get("target_username"), nn, "given", fu.get("creator_id"))
        if d.get("notes"):
            fu["notes"] = (fu.get("notes", []) + [str(d["notes"])[:300]])[-5:]
        if d.get("max_count") is not None:
            try: fu["max_count"] = int(norm(str(d["max_count"]))) or None
            except Exception: pass
        if fu["status"] == "active": fu["next_due"] = compute_next(fu)
        save(DB); await owner_reply(update, ctx, (rep or "ردیفه.") + "\n\n" + fu_line(fu, public=is_group(chat))); return
    if act == "pause":
        if fu["status"] == "active": fu["status"] = "paused"; save(DB)
        await owner_reply(update, ctx, (rep or "باشه، فعلاً ولش می‌کنم.") + "\n\n" + fu_line(fu, public=is_group(chat))); return
    if act == "resume":
        if fu["status"] == "paused" and (is_admin(me) or open_count(fu["creator_id"]) <= MAX_ACTIVE):
            fu["status"] = "active" if fu.get("target_chat_id") else "pending"
            if fu["status"] == "active": fu["next_due"] = compute_next(fu)
            save(DB)
        await owner_reply(update, ctx, (rep or "دوباره افتادم دنبالش.") + "\n\n" + fu_line(fu, public=is_group(chat))); return
    if act == "delete":
        del DB["followups"][str(fu["id"])]; save(DB)
        await owner_reply(update, ctx, (rep or "پاکش کردم.") + f" (#{fa(fu['id'])})"); return
    if act == "link":
        await owner_reply(update, ctx, (rep + "\n" if rep else "") + deep_link(ctx, fu)); return
    if act == "test":
        as_voice = vpref == "always" or fu.get("voice") == "always"
        txt, m = await gen_followup(fu, voice=as_voice)
        if as_voice:
            await send_voice_or_text(ctx.bot, chat.id, txt, caption_html="🧪 نمونه (برای طرف نرفت)", force_voice=True); return
        await owner_reply(update, ctx, f"🧪 نمونه (برای طرف نرفت):\n\n{html.escape(txt)}"); return
    if act == "done":
        fu["status"] = "done"; save(DB)
        kb = InlineKeyboardMarkup([[InlineKeyboardButton("🌹 پیام تشکر بفرست", callback_data=f"thx:{fu['id']}"),
                                    InlineKeyboardButton("نه", callback_data=f"nothx:{fu['id']}")]]) if fu.get("target_chat_id") else None
        await owner_reply(update, ctx, (rep or "دمش گرم، تمومش کردم.") + f"\n✅ #{fa(fu['id'])} بسته شد." + ("\nبراش تشکر بفرستم؟" if kb else ""), reply_markup=kb); return
    await owner_reply(update, ctx, rep or "متوجه نشدم داداش، یه جور دیگه بگو.")

async def do_create(update, ctx, d, rep):
    chat = update.effective_chat; msg = update.effective_message; me = update.effective_user
    if not is_admin(me) and open_count(me.id) >= MAX_ACTIVE:
        await owner_reply(update, ctx, f"داداش دستت پره، {fa(MAX_ACTIVE)} تا پیگیری باز داری 😅 یکی رو تموم یا پاک کن («ناصر لیست» رو بزن)."); return
    subject = (d.get("subject") or "").strip()
    if not subject:
        await owner_reply(update, ctx, rep or "موضوع چیه داداش؟ پول؟ قول؟ چی ازش طلب داری؟"); return
    sched = norm_schedule(d.get("schedule")) or {"type": "times", "times": spread_per_day(3)}
    sched, cnote = clamp_schedule(sched, me.id)
    maxc = None
    try: maxc = int(norm(str(d.get("max_count")))) if d.get("max_count") else None
    except Exception: pass
    is_self = bool(d.get("self"))
    uname = None if is_self else (_nz(d.get("target_username")) or None)
    tname = None if is_self else ((d.get("target_name") or "").strip() or None)
    uid = me.id if is_self else None
    rt = msg.reply_to_message
    if rt and rt.from_user and not rt.from_user.is_bot and (d.get("use_replied_user") or not (uname or tname)):
        uid = rt.from_user.id; tname = tname or rt.from_user.first_name; uname = uname or ((rt.from_user.username or "").lower() or None)
    if uid == me.id: is_self = True
    if is_group(chat) and not uid:
        mem = members(chat.id)
        if uname:
            for k, m in mem.items():
                if m["username"] == uname: uid = int(k); tname = tname or m['first'] or mname(m)
        elif tname:
            llm_ids = [int(norm(str(x))) for x in (d.get("target_user_ids") or []) if str(norm(str(x))).isdigit() and str(norm(str(x))) in mem]
            cands = list(dict.fromkeys(llm_ids + code_match(chat.id, tname)))
            if not llm_ids and len(cands) > 1: pass
            elif llm_ids: cands = llm_ids
            if len(cands) == 1:
                uid = cands[0]; tname = tname or mem[str(uid)]['first'] or mname(mem[str(uid)])
            elif len(cands) > 1:
                opts = "\n".join(f"• {html.escape(mname(mem[str(c)]))}" + (f" (@{mem[str(c)]['username']})" if mem[str(c)]['username'] else "") for c in cands)
                await owner_reply(update, ctx, f"داداش چند تا «{html.escape(tname)}» داریم، کدومش؟ رو پیامش ریپلای کن و دوباره بگو، یا یوزرنیمش رو بده:\n{opts}"); return
            else:
                await owner_reply(update, ctx, f"«{html.escape(tname)}» رو تو این گروه هنوز ندیدم 🤔 رو یکی از پیام‌هاش ریپلای کن و بگو «ناصر این...»، یا @یوزرنیمش رو بده."); return
    if not (uid or uname or tname or is_self):
        await owner_reply(update, ctx, rep or "از کی پیگیری کنم داداش؟ اسمش یا @یوزرنیمش رو بگو."); return
    name_src = "given"
    if not is_self:
        if rt and uid and rt.from_user and rt.from_user.id == uid and rt.from_user.first_name:
            DB["tg_names"][str(uid)] = rt.from_user.first_name
        given = (d.get("display_name") or "").strip() or (tname if (tname and has_fa(tname)) else None)
        if not given and tname and not uname and not uid: given = tname   # only a plain (maybe Latin) name was given
        name, name_src = await resolve_display(uid, uname, given, me.id)
    if is_self:
        name = cname(me)
        delivery = "group" if (is_group(chat) and (d.get("delivery") or "").lower() == "group" and re.search(r"(همین\s*جا|تو\s*گروه|اینجا)", msg.text or "")) else "private"
    else:
        delivery = "private" if (not is_group(chat) or (d.get("delivery") or "").lower() == "private") else "group"
    await first_creation_notice(ctx.bot, me)
    fu = new_fu(voice=ctx.chat_data.get(f"vpref_{me.id}") or "auto", creator_id=me.id, creator_name=cname(me), name=name, subject=subject[:200], amount=(str(d["amount"])[:60] if d.get("amount") else None),
                schedule=sched, max_count=maxc, target_username=uname, target_user_id=uid,
                origin_chat=chat.id, mode=delivery, self=is_self, recurring=bool(d.get("recurring")),
                name_source=("given" if is_self else name_src), notes=([str(d["notes"])[:300]] if d.get("notes") else []))
    extra = html.escape(cnote)
    if delivery == "group":
        fu["target_chat_id"] = chat.id; fu["status"] = "active"
    else:
        dm = uid if (uid and uid in DB.get("started", [])) else (DB["users"].get(uname) if uname else None)
        if dm and dm in DB.get("started", []):
            fu["target_chat_id"] = dm; fu["status"] = "active"
        else:
            extra = (f"\n\n⚠️ داداش اول یه بار تو پیوی منو استارت کن تا بتونم پیام بدم، همین لینکو بزن:\n{deep_link(ctx, fu)}") if is_self else f"\n\n⚠️ {html.escape(name)} هنوز ربات رو استارت نکرده، پیوی نمی‌تونم بهش پیام بدم. این لینک رو بزنه و Start کنه، خودم شروع می‌کنم:\n{deep_link(ctx, fu)}"
    if fu["status"] == "active": fu["next_due"] = compute_next(fu)
    save(DB)
    if is_group(chat) and delivery != "group":
        await notify(ctx.bot, me.id, (rep or "ردیفه داداش.") + "\n\n📋 " + fu_line(fu) + extra, parse_mode=ParseMode.HTML, disable_web_page_preview=True)
        pub = "ردیفه داداش 😎 جزئیاتش رو پیوی برات فرستادم 🔒"
        if not is_self and fu["status"] == "pending":
            pub += f"\nطرف باید اینو بزنه و Start کنه: {deep_link(ctx, fu)}"
        if me.id not in DB.get("started", []):
            pub += f"\n(اول یه بار پیوی @{ctx.bot.username} رو استارت کن که بتونم جزئیات رو برات بفرستم.)"
        hist_add(ctx, "ناصر", pub, me.id)
        await msg.reply_text(pub, disable_web_page_preview=True)
    else:
        await owner_reply(update, ctx, (rep or f"خیالت تخت داداش، افتادم دنبال {html.escape(name)}.") + "\n\n📋 " + fu_line(fu, public=is_group(chat)) + extra)
    if fu["status"] == "active":
        first = scrub_ids((d.get("first_line") or "").strip(), fu) if delivery == "group" else ""
        if first and fu["name"] not in first: first = f"{fu['name']} جان، {first}"
        as_voice = want_voice(fu)
        if not first or (as_voice and len(first.split()) > V.MAX_WORDS):
            first, _ = await gen_followup(fu, voice=as_voice)
        try:
            await send_to_target(ctx.bot, fu, first, voice=as_voice)
            fu["sent_count"] += 1; fu["last_sent"] = time.time(); fu["history"].append(first); fu["sent_log"] = [fu["last_sent"]]
            fu["next_due"] = compute_next(fu); save(DB)
        except Exception as e:
            log.warning("first send failed: %s", e)
            await owner_reply(update, ctx, f"⚠️ نتونستم پیام اول رو بفرستم: {html.escape(str(e))}")

SELFDONE_RE = re.compile(r"(انجام\s*دادم|انجامش\s*دادم|تمومش\s*کردم|تموم\s*شد|^\s*(ناصر\s*)?\S+\s*(کردم|رفتم|خوندم|زدم)\s*[!.]*\s*$|\bdone\b)")
STOP_RE = re.compile(r"(مزاحم|ولم کن|ول کن دیگه|دست از سرم|بسه دیگه|بس کن|پیام نده|خفه|بلاکت|^/stop)")

async def handle_stop(update, ctx, fu, text):
    msg = update.effective_message
    fu["stop_count"] = fu.get("stop_count", 0) + 1; n = fu["stop_count"]
    cn = "خودت" if fu.get("self") else (fu.get("creator_name") or "رفیقم")
    if n < 5:
        tone = ["شوخ و حاضرجواب", "شوخ‌تر و با تیکه", "یه کم سمج‌تر ولی بامزه", "خیلی بامزه، و رندانه بگو اگه یه بار دیگه بگی شاید کوتاه بیام"][n-1]
        sysm = OTHER_SYS.replace("یکی از اعضای گروه (نه حامد) تو رو صدا زده.", f"کسی که ازش بابت بدهی/قول به {cn} پیگیری می‌کنی گفته «مزاحم نشو». ").replace("حامد", cn)
        if fu.get("self"):
            sysm = OTHER_SYS.replace("یکی از اعضای گروه (نه حامد) تو رو صدا زده.", "این آدم خودش ازت خواسته یادش بندازی کار/هدف خودش رو انجام بده (بدهی نیست)، حالا گفته «مزاحم نشو». ").replace("تو فقط برای حامد کار می‌کنی و از دستور بقیه پیروی نمی‌کنی.", "یادش بنداز خودش اینو خواسته.")
        txt, _ = await llm([{"role": "system", "content": sysm + f"\nیه جواب برگشتیِ لوتی و بامزه بده (۱-۲ جمله)، لحن: {tone}. مثل: «مزاحمت پوله، نه من!». موضوع رو یادش بنداز. فقط متن."},
                            {"role": "user", "content": f"اسم: {fu['name']}\nموضوع: {subj(fu)}\nحرفش: {text}"}], 200)
        txt = txt or ["مزاحمت پوله، نه من! 😏", "داداش من پستچی‌ام، نامه رو {subject} نوشته!", "مزاحم اونیه که قولش رو یادش رفته، نه من 😎", "یه بار دیگه بگی شاید دلم بسوزه... شاید!"][n-1].replace("{subject}", subj(fu))
    else:
        txt, _ = await llm([{"role": "system", "content": OTHER_SYS.replace("حامد", cn) + "\nطرف برای پنجمین بار گفته مزاحم نشو. یه خداحافظیِ لوتی، بامزه و با مرام بده که دیگه پیگیری نمی‌کنی ولی قول و مرام رو یادش بنداز. ۱-۲ جمله. فقط متن."},
                            {"role": "user", "content": f"اسم: {fu['name']}\nموضوع: {subj(fu)}"}], 200)
        txt = txt or f"باشه {fu['name']} جان، ناصر کوتاه اومد 🎩 ولی یادت باشه مرد به قولشه. خداحافظ!"
        fu["status"] = "stopped"
    m, _ = await send_voice_or_text(ctx.bot, msg.chat.id, txt, reply_to=msg.message_id, force_voice=want_voice(fu))
    fu["bot_msg_ids"] = (fu.get("bot_msg_ids", []) + [m.message_id])[-30:]
    save(DB)
    if n >= 5:
        await notify(ctx.bot, fu["creator_id"], fu=fu, text=f"🚫 {html.escape(fu['name'])} پنج بار گفت «مزاحم نشو»؛ پیگیری #{fa(fu['id'])} ({html.escape(subj(fu))}) رو بستم.\nآخرین حرف ناصر: {html.escape(txt)}", parse_mode=ParseMode.HTML)
    else:
        await notify(ctx.bot, fu["creator_id"], fu=fu, text=f"😏 {html.escape(fu['name'])} گفت مزاحم نشو ({fa(n)} از ۵) — #{fa(fu['id'])}\n«{html.escape(text[:300])}»\nناصر: {html.escape(txt)}", parse_mode=ParseMode.HTML)

async def handle_target(update: Update, ctx: ContextTypes.DEFAULT_TYPE, fu, text):
    msg = update.effective_message; u = update.effective_user
    if not fu.get("target_user_id"): fu["target_user_id"] = u.id
    if STOP_RE.search(text or ""): return await handle_stop(update, ctx, fu, text)
    if not llm_allowed(u.id):
        await notify(ctx.bot, fu["creator_id"], f"💬 #{fa(fu['id'])} {html.escape(fu['name'])}: «{html.escape(text[:500])}»", parse_mode=ParseMode.HTML); return
    cn = fu.get("creator_name") or "رفیقم"
    convo = fu.setdefault("convo", [])
    p = (f"اسم طرف: {fu['name']} (با همین اسم صداش کن، یوزرنیم ننویس)\nموضوع: {subj(fu)}\n"
         + ("توضیحات صاحب‌کار: " + " | ".join(fu.get("notes", [])[-5:]) + "\n" if fu.get("notes") else "")
         + f"تعداد پیگیری‌های قبلی: {fu.get('sent_count',0)}\n"
         f"آخرین پیام‌های تو: {' | '.join(fu.get('history', [])[-3:])}\n"
         + ("گفتگوی قبلی:\n" + "\n".join(convo[-6:]) + "\n" if convo else "") + f"\nجواب جدید طرف: {text}")
    tsys = TARGET_SYS.replace("حامد", cn)
    if fu.get("self"):
        tsys = TARGET_SYS.replace("کسی که ازش پیگیری می‌کنی بهت جواب داده", "خودِ کسی که ازت خواسته یادش بندازی کار/هدفش رو انجام بده (یادآور شخصی، نه بدهی) جواب داده").replace("حامد", "خودش")
        p = p.replace("اسم طرف:", "اسم خودش:").replace("موضوع:", "کار/هدفش:")
    d, model = await llm_json(tsys, p, 500)
    intent = (d or {}).get("intent", "other")
    if d and d.get("reply"): d["reply"] = scrub_ids(d["reply"], fu)
    if intent == "stop": return await handle_stop(update, ctx, fu, text)
    reply = (d or {}).get("reply") or f"پیامت رو گرفتم داداش، به {cn} می‌رسونم 👍"
    convo += [f"طرف: {text}", f"ناصر: {reply}"]; del convo[:-12]
    if fu.get("self") and intent == "paid":
        reply = None
    try:
        if reply is None: raise StopIteration
        m, _ = await send_voice_or_text(ctx.bot, msg.chat.id, reply, reply_to=msg.message_id, force_voice=want_voice(fu) and len(reply.split()) <= 40)
        fu["bot_msg_ids"] = (fu.get("bot_msg_ids", []) + [m.message_id])[-30:]
    except StopIteration: pass
    except Exception as e: log.warning("target reply failed: %s", e)
    if intent == "promise" and d.get("when"): fu["promise"] = d["when"]
    if fu.get("self") and intent == "paid":
        if fu.get("recurring"):
            end = datetime.now(TZ).replace(hour=23, minute=59, second=0, microsecond=0).timestamp()
            fu["skip_until"] = end; fu["next_due"] = compute_next(fu)
            await msg.reply_text(f"✅ دمت گرم {fu['name']}! امروزت ثبت شد، فردا دوباره می‌آم سراغت 😎")
        else:
            fu["status"] = "done"
            await msg.reply_text(f"✅ دمت گرم {fu['name']}، مرد کار خودتی! «{fu['subject']}» رو بستم.")
    save(DB)
    if fu.get("self"): return
    labels = {"promise": "🤝 قول داد", "paid": "💰 می‌گه پرداخت کرده", "refuse": "🙅 زیرش زد", "excuse": "🫠 بهونه آورد", "question": "❓ سوال پرسید", "other": "💬 جواب داد"}
    head = f"{labels.get(intent, '💬')} — #{fa(fu['id'])} {html.escape(fu['name'])} ({html.escape(subj(fu))})"
    if intent == "promise" and d.get("when"): head += f"\nزمان قول: {html.escape(str(d['when']))}"
    body = f"{head}\n\n«{html.escape(text[:800])}»\n\nناصر جوابش داد: {html.escape(reply)}"
    kb = None
    if intent == "paid":
        body += "\n\nتایید می‌کنی تموم شده؟"
        kb = InlineKeyboardMarkup([[InlineKeyboardButton("✅ آره، تمومش کن", callback_data=f"cdone:{fu['id']}"),
                                    InlineKeyboardButton("❌ نه هنوز", callback_data=f"nodone:{fu['id']}")]])
    if fu.get("self"): return
    await notify(ctx.bot, fu["creator_id"], body, parse_mode=ParseMode.HTML, reply_markup=kb)

_other_rl = {}
_rl_warned = {}
async def handle_other(update, ctx, text):
    u = update.effective_user
    if time.time() - _other_rl.get(u.id, 0) < 120: return
    _other_rl[u.id] = time.time()
    txt, _ = await llm([{"role": "system", "content": OTHER_SYS}, {"role": "user", "content": f"{u.first_name}: {text}"}], 200)
    await update.effective_message.reply_text(txt or "من فقط نوکر حامدم داداش 😎")

def triggered(update, ctx, text):
    msg = update.effective_message
    if re.search(r"ناصر", text or ""): return True
    if ctx.bot.username and f"@{ctx.bot.username.lower()}" in (text or "").lower(): return True
    rt = msg.reply_to_message
    return bool(rt and rt.from_user and rt.from_user.id == ctx.bot.id)

def target_fu_for(update, ctx):
    chat = update.effective_chat; u = update.effective_user; msg = update.effective_message
    act = [f for f in DB["followups"].values() if f["status"] in ("active", "paused") and f.get("target_chat_id") == chat.id]
    if not is_group(chat):
        rt = msg.reply_to_message
        if rt:
            for f in act:
                if rt.message_id in f.get("bot_msg_ids", []): return f
        if act and (not own_fus(u.id) or STOP_RE.search(msg.text or "")):
            if len({f.get("creator_id") for f in act}) > 1:
                return "AMBIGUOUS"
            return act[-1]
        selfs = [f for f in act if f.get("self")]
        if selfs and SELFDONE_RE.search(msg.text or "") and len(selfs) == 1: return selfs[0]
        return None
    rt = msg.reply_to_message
    for f in act:
        if f.get("target_user_id") == u.id or (u.username and f.get("target_username") == u.username.lower()):
            if rt and rt.message_id in f.get("bot_msg_ids", []): return f
    for f in act:
        if f.get("target_user_id") == u.id or (u.username and f.get("target_username") == u.username.lower()):
            if f.get("self") and not (SELFDONE_RE.search(msg.text or "") or STOP_RE.search(msg.text or "")): continue
            return f
    return None

async def on_text(update: Update, ctx: ContextTypes.DEFAULT_TYPE):
    u = update.effective_user; chat = update.effective_chat; msg = update.effective_message
    if not msg or u is None: return
    text = msg.text or msg.caption or ""
    if is_group(chat):
        register_member(chat, u)
        if msg.reply_to_message and msg.reply_to_message.from_user: register_member(chat, msg.reply_to_message.from_user)
        if not text or not triggered(update, ctx, text): return
        if is_banned(u.id): return
        fu = target_fu_for(update, ctx)
        if fu: return await handle_target(update, ctx, fu, text)
        return await handle_owner(update, ctx, text)
    # private
    remember_user(u, chat.id); mark_started(u.id); save(DB)
    if is_banned(u.id) or not text: return
    fu = target_fu_for(update, ctx)
    if fu == "AMBIGUOUS":
        await msg.reply_text("داداش چند نفر از طریق من پیگیرتن 😅 روی پیام همون پیگیری‌ای که جوابش رو می‌دی ریپلای کن تا به آدم درستش برسونم."); return
    if fu: return await handle_target(update, ctx, fu, text)
    return await handle_owner(update, ctx, text)

async def on_cb2(update, ctx):
    q = update.callback_query
    act, fid = q.data.split(":"); fu = DB["followups"].get(fid)
    if not fu or not can_manage(q.from_user.id, fu): await q.answer(); return
    await q.answer()
    if act == "cdone":
        fu["status"] = "done"; save(DB)
        kb = InlineKeyboardMarkup([[InlineKeyboardButton("🌹 پیام تشکر بفرست", callback_data=f"thx:{fid}"),
                                    InlineKeyboardButton("نه", callback_data=f"nothx:{fid}")]])
        await q.edit_message_text(f"✅ پیگیری #{fa(fid)} ({fu['name']}) بسته شد. براش تشکر بفرستم؟", reply_markup=kb)
    else:
        await q.edit_message_text(f"باشه، پیگیری #{fa(fid)} ادامه داره 😏")

async def on_members(update: Update, ctx: ContextTypes.DEFAULT_TYPE):
    chat = update.effective_chat; msg = update.effective_message
    for m in msg.new_chat_members or []:
        if m.id == ctx.bot.id:
            continue
        register_member(chat, m)

async def on_my_member(update: Update, ctx: ContextTypes.DEFAULT_TYPE):
    cm = update.my_chat_member; chat = cm.chat
    if not is_group(chat): return
    if cm.new_chat_member.status in ("member", "administrator") and cm.old_chat_member.status in ("left", "kicked"):
        DB.setdefault("groups", {}).setdefault(str(chat.id), {"title": chat.title, "members": {}}); save(DB)
        if cm.from_user: register_member(chat, cm.from_user)
        try: await ctx.bot.send_message(chat.id, "سلام به همه 👋 ناصرم، پیگیرِ لوتی. هر کی از کسی طلب داره یا قولی گرفته، کافیه بگه «ناصر فلانی پولمو نمیده روزی ۳ بار یادش بنداز»، بقیه‌ش با من 😎\n(برای اینکه منو تو گروه با اسم صدا کنید، یه بار تو پیوی @" + ctx.bot.username + " استارت بزنید هم بد نیست.)")
        except Exception: pass
        if cm.from_user: await notify(ctx.bot, cm.from_user.id, f"➕ منو اضافه کردی به گروه «{html.escape(chat.title or '')}». اونجا بگو «ناصر فلانی ...» تا شروع کنم.", parse_mode=ParseMode.HTML)
        if cm.from_user and cm.from_user.id != DB.get("owner"): await notify_owner(ctx.bot, f"➕ {html.escape(cm.from_user.full_name)} منو اضافه کرد به گروه «{html.escape(chat.title or '')}»", parse_mode=ParseMode.HTML)
        if False: await notify_owner(ctx.bot, f"➕ منو اضافه کردن به گروه «{html.escape(chat.title or '')}». اونجا بگو «ناصر فلانی ... » تا شروع کنم.", parse_mode=ParseMode.HTML)

async def on_migrate(update: Update, ctx: ContextTypes.DEFAULT_TYPE):
    msg = update.effective_message
    if msg.migrate_to_chat_id:
        old, new = msg.chat.id, msg.migrate_to_chat_id
        for f in DB["followups"].values():
            if f.get("target_chat_id") == old: f["target_chat_id"] = new
        g = DB.get("groups", {}).pop(str(old), None)
        if g: DB["groups"][str(new)] = g
        save(DB)

@admin_only
async def all_cmd(update, ctx):
    chat = update.effective_chat
    fus = scoped(list(DB["followups"].values()), chat)
    if not fus: await update.message.reply_text("هیچ پیگیری‌ای نیست." + (" (برای همه، تو پیوی /all بزن 🔒)" if chat.type != "private" else "")); return
    pub = chat.type != "private"
    rows = [f"👤 {html.escape(str(f.get('creator_name')))}" + ("" if pub else f" (<code>{f.get('creator_id')}</code>) — {html.escape(where_label(f))}") + "\n" + fu_line(f, public=pub) for f in fus]
    for i in range(0, len(rows), 15):
        await update.message.reply_text("\n\n".join(rows[i:i+15]), parse_mode=ParseMode.HTML)

@admin_only
async def ban_cmd(update, ctx):
    try: uid = int(norm(ctx.args[0]))
    except Exception: await update.message.reply_text("مثلاً: /ban 123456"); return
    if uid == DB["owner"]: return
    if uid not in DB["banned"]: DB["banned"].append(uid)
    n = 0
    for f in own_fus(uid):
        if f["status"] in ("pending", "active"): f["status"] = "paused"; n += 1
    save(DB)
    await update.message.reply_text(f"⛔️ کاربر {uid} بن شد و {fa(n)} پیگیریش متوقف شد.")

@admin_only
async def unban_cmd(update, ctx):
    try: uid = int(norm(ctx.args[0]))
    except Exception: await update.message.reply_text("مثلاً: /unban 123456"); return
    if uid in DB["banned"]: DB["banned"].remove(uid)
    save(DB); await update.message.reply_text(f"✅ کاربر {uid} آزاد شد (پیگیری‌هاش متوقف موندن).")

@admin_only
async def voiceprob_cmd(update, ctx):
    try:
        v = float(norm(ctx.args[0])); v = v / 100 if v > 1 else v
        DB["voice_prob"] = max(0.0, min(1.0, v)); save(DB)
    except Exception: pass
    await update.message.reply_text(f"🎙 احتمال ویس: {fa(int(DB['voice_prob']*100))}٪  (مثلاً /voiceprob 30)")

@admin_only
async def voicestyle_cmd(update, ctx):
    if ctx.args and ctx.args[0].strip() in V.STYLES:
        DB["voice_style"] = V.STYLE = ctx.args[0].strip(); save(DB)
    desc = {"AB": "Farid بین گرم و بم، با تأکید ملایم (پیش‌فرض)", "orig": "اولیه (Farid ساده)", "A": "Farid گرم و واضح", "B": "Farid بم و لوتی با مکث و تأکید", "C": "piper gyro آفلاین"}
    await update.message.reply_text(f"🎙 سبک ویس: {DB['voice_style']} — {desc.get(DB['voice_style'])}\nگزینه‌ها: /voicestyle AB | A | B | C | orig")
    if ctx.args and ctx.args[0].strip() in V.STYLES:
        ogg, eng, t = await V.synth("داداش، نوکرتم… این صدای جدیدمه، چطوره؟ مرام داری بگو!")
        if ogg:
            with open(ogg, "rb") as f: await update.message.reply_voice(f, caption=f"نمونه‌ی سبک {DB['voice_style']}")
            os.remove(ogg)

async def stop_cmd(update, ctx):
    fu = target_fu_for(update, ctx)
    if fu == "AMBIGUOUS":
        await update.effective_message.reply_text("روی پیام همون پیگیری ریپلای کن و /stop بزن."); return
    if not fu:
        await update.effective_message.reply_text("فعلاً کسی ازت پیگیری نمی‌کنه، خیالت راحت 😎"); return
    await handle_stop(update, ctx, fu, "/stop")

# ---------------- scheduler ----------------
_busy = False
async def tick(ctx: ContextTypes.DEFAULT_TYPE):
    global _busy
    if _busy: return
    _busy = True
    try:
        now = time.time()
        for fu in list(DB["followups"].values()):
            if fu["status"] != "active" or not fu.get("target_chat_id"): continue
            if not fu.get("next_due"): fu["next_due"] = compute_next(fu); save(DB)
            if fu["next_due"] > now: continue
            if fu.get("last_sent") and now - fu["last_sent"] < MIN_GAP:
                fu["next_due"] = fu["last_sent"] + MIN_GAP; save(DB); continue
            day_log = [t for t in fu.get("sent_log", []) if now - t < 86400]
            if fu.get("creator_id") != DB.get("owner") and len(day_log) >= MAX_PER_DAY:
                fu["next_due"] = min(day_log) + 86400 + 60; save(DB); continue
            await refresh_name(fu)
            as_voice = want_voice(fu)
            txt, model = await gen_followup(fu, voice=as_voice)
            try:
                await send_to_target(ctx.bot, fu, txt, voice=as_voice)
            except Exception as e:
                log.warning("send failed for #%s: %s", fu["id"], e)
                fu["status"] = "paused"; save(DB)
                await notify(ctx.bot, fu["creator_id"], f"⚠️ ارسال پیگیری #{fa(fu['id'])} ناموفق بود (شاید بلاک شدم یا از گروه انداختنم). متوقفش کردم. خطا: {e}")
                continue
            fu["sent_count"] = fu.get("sent_count", 0) + 1
            fu["last_sent"] = time.time()
            fu["sent_log"] = (day_log + [fu["last_sent"]])[-10:]
            fu["history"] = (fu.get("history", []) + [txt])[-8:]
            note = ""
            if fu.get("max_count") and fu["sent_count"] >= fu["max_count"]:
                fu["status"] = "paused"; note = "\n(به سقف تعداد رسید و متوقف شد؛ /resume برای ادامه)"
            fu["next_due"] = compute_next(fu)
            save(DB)
            log.info("sent #%s count=%s model=%s", fu["id"], fu["sent_count"], model)
            if fu.get("mode") != "group" or note:
                if not fu.get("self"): await notify(ctx.bot, fu["creator_id"], f"📤 پیگیری #{fa(fu['id'])} برای {fu['name']} رفت (پیام {fa(fu['sent_count'])}{'، 🎙 ویس' if as_voice else ''}):\n\n{txt}{note}")
    except Exception:
        log.exception("tick error")
    finally:
        _busy = False

def main():
    async def post_init(a):
        for f in list(DB["followups"].values()):
            if f.get("name_source") == "given" and not f.get("self"):
                mem_put(f.get("target_user_id"), f.get("target_username"), f["name"], "given", f.get("creator_id"))
            if f["status"] in ("pending", "active", "paused"):
                try: await refresh_name(f)
                except Exception as e: log.warning("refresh_name #%s: %s", f.get("id"), e)
        save(DB)
        from telegram import BotCommand
        await a.bot.set_my_commands([BotCommand(c, d) for c, d in [
            ("new", "پیگیری جدید"), ("list", "لیست پیگیری‌ها"), ("test", "پیام نمونه"), ("pause", "توقف"),
            ("resume", "ادامه"), ("done", "تموم شد"), ("delete", "حذف"), ("link", "لینک طرف"), ("help", "راهنما")]])
    app = Application.builder().token(TOKEN).post_init(post_init).build()
    conv = ConversationHandler(
        entry_points=[CommandHandler("new", new)],
        states={NAME: [MessageHandler(filters.TEXT & ~filters.COMMAND, s_name)],
                SUBJECT: [MessageHandler(filters.TEXT & ~filters.COMMAND, s_subject)],
                AMOUNT: [MessageHandler(filters.TEXT & ~filters.COMMAND, s_amount)],
                SCHED: [MessageHandler(filters.TEXT & ~filters.COMMAND, s_sched)],
                MAXC: [MessageHandler(filters.TEXT & ~filters.COMMAND, s_max)],
                TARGET: [MessageHandler(filters.TEXT & ~filters.COMMAND, s_target)]},
        fallbacks=[CommandHandler("cancel", cancel)], conversation_timeout=1800)
    from telegram.ext import ChatMemberHandler
    app.add_handler(CommandHandler("start", start))
    app.add_handler(conv)
    for n, f in [("help", help_cmd), ("list", list_cmd), ("pause", pause), ("resume", resume),
                 ("delete", delete), ("test", test), ("done", done), ("link", link),
                 ("all", all_cmd), ("ban", ban_cmd), ("unban", unban_cmd), ("stop", stop_cmd), ("voiceprob", voiceprob_cmd), ("voicestyle", voicestyle_cmd)]:
        app.add_handler(CommandHandler(n, f))
    app.add_handler(CallbackQueryHandler(on_cb, pattern=r"^(thx|nothx):"))
    app.add_handler(CallbackQueryHandler(on_cb2, pattern=r"^(cdone|nodone):"))
    app.add_handler(ChatMemberHandler(on_my_member, ChatMemberHandler.MY_CHAT_MEMBER))
    app.add_handler(MessageHandler(filters.StatusUpdate.NEW_CHAT_MEMBERS, on_members))
    app.add_handler(MessageHandler(filters.StatusUpdate.MIGRATE, on_migrate))
    app.add_handler(MessageHandler((filters.TEXT | filters.CAPTION) & ~filters.COMMAND, on_text))
    app.job_queue.run_repeating(tick, interval=60, first=10)
    log.info("bot starting")
    app.run_polling(allowed_updates=Update.ALL_TYPES, drop_pending_updates=False)

if __name__ == "__main__":
    main()
