"""Gender awareness hotfix (mirrors worker/src/gender.ts)."""
import re
FS = set('طلا سارا مینا مریم زهرا فاطمه نرگس لیلا نازنین الهام شیما نگار پریسا ساناز مهسا آیدا ترانه یاسمن یاسمین نیلوفر هانیه ریحانه سمیرا شیرین ستاره مهناز فرشته پگاه آزاده رها هستی کیمیا بهاره سحر زینب معصومه سمانه مژگان نسرین پروانه مهتاب نیوشا آتنا غزل دنیا روژان تینا آناهیتا پرستو نازی مونا نیکی یلدا صبا ملیکا محدثه فائزه عسل شادی ثمین آرزو آوا سوگند نفس ژیلا مهری منیژه سیما شهلا فریبا رویا مرجان شبنم نسیم الناز مهشید مینو گلاره گلناز بهار پرنیان النا هلیا آیلین ساره سارینا مائده نجمه طاهره اعظم اکرم راحله سپیده شقایق لادن ندا نوشین'.split()); MS = set('علی محمد رضا حامد مهدی حسین حسن عباس امیر احمد سعید مجید مسعود جواد کاظم داوود یوسف ابراهیم اسماعیل مصطفی مرتضی محسن میلاد سینا آرش بهروز بهزاد پویا پیمان کامران کیوان فرهاد فرزاد فرشید نیما امین ایمان بابک بهنام پرویز جمشید حمید حمیدرضا علیرضا محمدرضا امیرحسین سجاد صادق عرفان عماد فرید کیان مازیار مانی ماهان مهران مهرداد نادر ناصر وحید هادی هومن یاسر یاشار شهاب شایان شاهین رامین رسول روزبه سامان سهیل سروش اصغر اکبر قاسم جعفر صالح طاها متین محمدحسین مهیار آرمان آریا آرین بردیا دانیال سپهر'.split())
LAT_F = set(['sara', 'mina', 'maryam', 'zahra', 'fatemeh', 'narges', 'leila', 'nazanin', 'elham', 'shima', 'negar', 'parisa', 'sanaz', 'mahsa', 'aida', 'yasaman', 'niloofar', 'hanieh', 'samira', 'shirin', 'setareh', 'tala', 'ghazal', 'donya', 'tina', 'mona', 'niki', 'yalda', 'saba', 'melika', 'asal', 'shadi', 'arezoo', 'ava', 'sahar', 'zeinab', 'bahar', 'elnaz', 'anahita', 'parastoo', 'nasim', 'neda']); LAT_M = set(['ali', 'mohammad', 'mohamad', 'mmd', 'reza', 'hamed', 'mehdi', 'hossein', 'hosein', 'hassan', 'abbas', 'amir', 'ahmad', 'saeed', 'majid', 'masoud', 'javad', 'milad', 'sina', 'arash', 'pouya', 'peyman', 'farhad', 'nima', 'amin', 'iman', 'babak', 'behnam', 'hamid', 'alireza', 'sajjad', 'erfan', 'kian', 'mani', 'mahan', 'mehran', 'vahid', 'hadi', 'shahab', 'ramin', 'saman', 'soroush', 'matin', 'arman', 'aria', 'arian', 'danial', 'sepehr', 'naser', 'mostafa', 'morteza', 'mohsen', 'yousef', 'kamran', 'bob', 'john', 'david'])
def guess(name):
    raw = (name or "").strip()
    if not raw: return "unknown"
    if raw == "رفیق": return "unknown"
    if re.match(r"^(خانم|خانوم|آبجی|ابجی|خواهر)", raw): return "female"
    first = raw.replace("\u200c", " ").split()[0]
    if first in FS: return "female"
    if first in MS: return "male"
    lat = re.sub(r"[^a-z]", "", first.lower())
    if lat in LAT_F: return "female"
    if lat in LAT_M: return "male"
    return "unknown"
def gender_of(fu):
    return fu.get("gender") or guess(fu.get("name"))
def hint(g, who="طرف"):
    if g == "female": return f"{who} خانمه: با لحن لوتی ولی محترمانه با «آبجی»، «خواهر» یا «خانم» صداش کن (یا فقط اسمش)؛ هیچ‌وقت «داداش»، «داش»، «پسر»، «آقا»، «مرد» یا تعبیرای مردونه مثل «مرد و قولش» نگو."
    if g == "male": return f"{who} آقاست: «داداش»، «داش» و «رفیق» اوکیه."
    return f"جنسیت {who} معلوم نیست: از کلمه‌های جنسیتی مثل «داداش»، «داش»، «آبجی»، «آقا»، «خانم»، «پسر»، «مرد» استفاده نکن؛ به‌جاش «رفیق» یا فقط اسمش رو بگو."
NB = r"(?<![^\W\d_])"; NA = r"(?![^\W\d_]|\u200c)"
def fix(t, g):
    if not t or g == "male": return t
    for a, b in [(r"مرد\s+کار\s+خودتی", "کارت درسته"), (r"مرد\s+و\s+قولش", "آدم و قولش"), (r"مرد\s+به\s+قولشه", "آدم به قولشه")]: t = re.sub(a, b, t)
    w = "آبجی" if g == "female" else "رفیق"
    t = re.sub(r"داداش(?!\s*ناصر)", w, t)
    t = re.sub(r"(?<![\w\u200c])داش(?![\w\u200c])(?!\s*ناصر)", w, t)
    if g == "female":
        t = re.sub(r"(?<![\w\u200c])آقا(?![\w\u200c])", "خانم", t); t = re.sub(r"(?<![\w\u200c])پسر(?![\w\u200c])", "خانم", t)
        t = re.sub(r"قول\s+مردونه", "قول", t)
    else:
        t = re.sub(r"(?<![\w\u200c])آقا\s+", "", t)
    return re.sub(w + r"\s+" + w, w, t)
