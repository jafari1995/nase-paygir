# ناصر پیگیر — Naser Paygir 🤝

ربات تلگرامیِ پیگیرِ لوتی‌منش: بدهی، قول یا هر خواسته‌ای رو با لحن داش‌مشتی، شوخ و کمی محکم از طرف پیگیری می‌کنه — متنی یا با ویس کوتاه — و فقط از **مدل‌های رایگان OpenRouter** استفاده می‌کنه.

A Telegram follow-up ("debt collector") bot with a witty, chivalrous Iranian *lūtī* persona. It reminds people about debts, promises or tasks on a schedule, answers them in character (sometimes by voice), and uses **only free OpenRouter models**.

---

## ✨ امکانات / Features
- گفتگوی آزاد فارسی: «ناصر @reza پولمو نمیده روزی ۵ بار یادش بنداز» — بدون نیاز به دستور
- کار در پیوی و گروه (در گروه با کلمه‌ی «ناصر»، منشن یا ریپلای)
- چندکاربره: هر کس پیگیری‌های خودش رو می‌سازه و فقط همون‌ها رو می‌بینه؛ ادمین (اولین کسی که /start می‌زنه) همه رو مدیریت می‌کنه
- یادآور شخصی: «ناصر روزی ۳ بار یادم بنداز ورزش کنم»
- ویس کوتاه فارسی با edge-tts (صدای fa-IR-FaridNeural) و fallback آفلاین piper
- یادگرفتن اسم واقعی طرف، یادداشت/زمینه برای هر پیگیری
- «مزاحم نشو»: ۴ بار جواب بامزه، بار پنجم پیگیری بسته می‌شه
- حریم خصوصی: پیگیری‌های پیوی هیچ‌وقت در گروه نشون داده نمی‌شن

- Free-form Persian commands, private chats and groups, multi-user with per-user isolation, self-reminders, short Persian voice notes, name memory and notes, playful opt-out after 5 «مزاحم نشو», strict privacy scoping.

## 🔒 فقط مدل رایگان / Free models only
هر مدلی که آخرش `:free` نباشه رد می‌شه؛ درخواست‌ها با `provider.max_price = 0` فرستاده می‌شن و هر پاسخی که از مدل غیررایگان یا با هزینه‌ی غیرصفر بیاد دور ریخته می‌شه.
Any model id not ending in `:free` is refused, requests carry `provider.max_price = 0`, and responses served by a non-free model or with non-zero cost are discarded.

## ⚙️ نصب و اجرا / Setup & run
```bash
git clone https://github.com/jafari1995/nase-paygir.git && cd nase-paygir
python3 -m pip install -r requirements.txt     # needs Python 3.11+
sudo apt install ffmpeg                          # for voice notes
cp .env.example .env && nano .env                # TELEGRAM_BOT_TOKEN, OPENROUTER_API_KEY
./start.sh                                       # runs run.sh in background (auto-restart), logs -> bot.log
```
- توکن ربات از @BotFather، کلید از https://openrouter.ai/keys
- برای اینکه ربات در گروه کلمه‌ی «ناصر» رو بدون منشن بفهمه: در @BotFather دستور `/setprivacy` ← ربات ← **Disable**، بعد ربات رو از گروه حذف و دوباره اضافه کنید (یا ادمینش کنید).
- Optional offline voice: download `fa_IR-gyro-medium.onnx` (+ `.onnx.json`) from `rhasspy/piper-voices` into `./piper/`.

## 💬 استفاده / Usage
بعد از `/start` در پیوی (اولین نفر ادمین می‌شه):
- «ناصر @reza پولمو نمیده روزی ۵ بار یادش بنداز» (در گروه: همون گروه؛ «پیوی بهش پیام بده» برای خصوصی)
- «ناصر اسم @reza12 رو رضا بذار» / «ناصر بهش بگو قرار بود تا جمعه بدی»
- «ناصر رضا رو فعلاً ول کن» / «ناصر لیست» / «ناصر رضا پولو داد»
- «ناصر روزی ۳ بار یادم بنداز ورزش کنم» — جواب «انجام دادم» = امروز تموم
- «با ویس یادش بنداز» / «بدون ویس»

### دستورها / Commands
| Command | |
|---|---|
| `/new` | ساخت قدم‌به‌قدم (پیوی) / guided creation |
| `/list` | پیگیری‌های خودت (در گروه فقط همون گروه) / your follow-ups |
| `/pause` `/resume` `/done` `/delete` `/test` `/link` `<id>` | مدیریت / manage |
| `/stop` | برای طرفِ پیگیری: «مزاحم نشو» / target opt-out (5th time stops) |
| `/help` | راهنما |
| admin: `/all` `/ban <id>` `/unban <id>` `/voiceprob <0-100>` `/voicestyle AB\|A\|B\|C\|orig` | فقط ادمین (پیوی) |

## 🧱 محدودیت‌ها / Limits (non-admin)
حداکثر ۵ پیگیری باز، روزی ۵ پیام برای هر پیگیری، حداقل ۱ ساعت فاصله، ۲۰ پیام آزاد در ساعت.
Max 5 open follow-ups, 5 messages/day per follow-up, ≥1 h spacing, 20 free-form parses/hour.

## 📁 Files
- `bot.py` — Telegram handlers, scheduler, storage (`data.json`, chmod 600), privacy scoping
- `naser.py` — persona & intent-parsing prompts
- `voice.py` — TTS styles (edge-tts / piper) + ffmpeg FX → OGG/Opus voice notes
- `run.sh` / `start.sh` — restart loop & background launcher

---

## ☁️ Cloudflare Workers (worker/)

**فارسی** — نسخه‌ی TypeScript ناصر در پوشه‌ی `worker/` است و روی Cloudflare Workers اجرا می‌شود (بدون نیاز به روشن بودن کامپیوتر):
- وبهوک تلگرام: `POST https://naser-paygir.abbas30000.workers.dev/telegram` (هدر `X-Telegram-Bot-Api-Secret-Token` بررسی می‌شود)
- کران هر دقیقه (`* * * * *`) برای ارسال پیگیری‌ها؛ همه‌ی داده‌ها در D1 (`naser-paygir-db`)
- ویس: edge-tts (fa-IR-FaridNeural) از طریق WebSocket، سبک AB با prosody جمله‌به‌جمله، خروجی MP3 (تلگرام sendVoice قبول می‌کند)
- فقط مدل‌های رایگان OpenRouter (`:free` + سقف قیمت صفر)
- آگاهی از جنسیت: برای خانم‌ها «آبجی/خواهر/خانم»، برای نامعلوم «رفیق»؛ با «فلانی خانمه/پسره» قابل تغییر است

راه‌اندازی دوباره از GitHub:
```bash
git clone https://github.com/jafari1995/nase-paygir.git && cd nase-paygir/worker
npm install
npx wrangler login
npx wrangler d1 execute naser-paygir-db --remote --file=schema.sql   # فقط بار اول (دیتابیس جدید → database_id را در wrangler.toml عوض کنید)
npx wrangler secret put TELEGRAM_BOT_TOKEN
npx wrangler secret put OPENROUTER_API_KEY
npx wrangler deploy
# سپس وبهوک: python3 cutover.py set-webhook   (secret_token از توکن مشتق می‌شود)
```
برگشت به نسخه‌ی پایتون (rollback): `python3 worker/cutover.py rollback` (یعنی deleteWebhook و سپس `./start.sh`).

**English** — `worker/` is the TypeScript port running on Cloudflare Workers: Telegram webhook with secret-token check, a 1-minute Cron Trigger, all state in D1 (`naser-paygir-db`; see `schema.sql`, `migrate_from_json.py` converts the old `data.json`). Voice uses edge-tts over an outbound WebSocket (MP3 24 kHz; the service rejects `ogg-24khz-16bit-mono-opus`). Free OpenRouter models only. Redeploy with the commands above (`wrangler.toml` holds the D1 binding, cron and `BOT_USERNAME`). Local tests: `python3 migrate_from_json.py ../data.json .migrate/test.sql naser_paygir_bot && npm test` (Telegram calls are mocked by Miniflare; OpenRouter is real).
