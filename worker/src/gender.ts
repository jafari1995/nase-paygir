// Gender awareness: how Naser addresses a person (target, creator, self).
export type Gender = "male" | "female" | "unknown";
const F = "طلا سارا مینا مریم زهرا فاطمه نرگس لیلا نازنین الهام شیما نگار پریسا ساناز مهسا آیدا ترانه یاسمن یاسمین نیلوفر هانیه ریحانه سمیرا شیرین ستاره مهناز فرشته پگاه آزاده رها هستی کیمیا بهاره سحر زینب معصومه سمانه مژگان نسرین پروانه مهتاب نیوشا آتنا غزل دنیا روژان تینا آناهیتا پرستو نازی مونا نیکی یلدا صبا ملیکا محدثه فائزه عسل شادی ثمین آرزو آوا سوگند نفس ژیلا مهری منیژه سیما شهلا فریبا رویا مرجان شبنم نسیم الناز مهشید مینو گلاره گلناز بهار پرنیان النا هلیا آیلین ساره سارینا مائده نجمه طاهره اعظم اکرم راحله سپیده شقایق لادن ندا نوشین";
const M = "علی محمد رضا حامد مهدی حسین حسن عباس امیر احمد سعید مجید مسعود جواد کاظم داوود یوسف ابراهیم اسماعیل مصطفی مرتضی محسن میلاد سینا آرش بهروز بهزاد پویا پیمان کامران کیوان فرهاد فرزاد فرشید نیما امین ایمان بابک بهنام پرویز جمشید حمید حمیدرضا علیرضا محمدرضا امیرحسین سجاد صادق عرفان عماد فرید کیان مازیار مانی ماهان مهران مهرداد نادر ناصر وحید هادی هومن یاسر یاشار شهاب شایان شاهین رامین رسول روزبه سامان سهیل سروش اصغر اکبر قاسم جعفر صالح طاها متین محمدحسین مهیار آرمان آریا آرین بردیا دانیال سپهر";
const FS = new Set(F.split(" ")), MS = new Set(M.split(" "));
const LAT_F = new Set(["sara", "mina", "maryam", "zahra", "fatemeh", "narges", "leila", "nazanin", "elham", "shima", "negar", "parisa", "sanaz", "mahsa", "aida", "yasaman", "niloofar", "hanieh", "samira", "shirin", "setareh", "tala", "ghazal", "donya", "tina", "mona", "niki", "yalda", "saba", "melika", "asal", "shadi", "arezoo", "ava", "sahar", "zeinab", "bahar", "elnaz", "anahita", "parastoo", "nasim", "neda"]);
const LAT_M = new Set(["ali", "mohammad", "mohamad", "mmd", "reza", "hamed", "mehdi", "hossein", "hosein", "hassan", "abbas", "amir", "ahmad", "saeed", "majid", "masoud", "javad", "milad", "sina", "arash", "pouya", "peyman", "farhad", "nima", "amin", "iman", "babak", "behnam", "hamid", "alireza", "sajjad", "erfan", "kian", "mani", "mahan", "mehran", "vahid", "hadi", "shahab", "ramin", "saman", "soroush", "matin", "arman", "aria", "arian", "danial", "sepehr", "naser", "mostafa", "morteza", "mohsen", "yousef", "kamran", "bob", "john", "david"]);

/** Fast local guess from a name; null if not known. */
export function guessGender(name: string | null | undefined): Gender | null {
  const raw = String(name || "").trim();
  if (!raw || raw === "رفیق") return raw === "رفیق" ? "unknown" : null;
  const first = raw.replace(/[\u200c]/g, " ").split(/\s+/)[0].replace(/^(آقا|اقا)$/, "");
  if (/^(خانم|خانوم|آبجی|ابجی|خواهر)/.test(raw)) return "female";
  if (/^(آقا|اقا|داداش|داش)\s/.test(raw)) return "male";
  if (FS.has(first)) return "female";
  if (MS.has(first)) return "male";
  const lat = first.toLowerCase().replace(/[^a-z]/g, "");
  if (LAT_F.has(lat)) return "female";
  if (LAT_M.has(lat)) return "male";
  return null;
}
export function normGender(x: any): Gender | null {
  const s = String(x ?? "").toLowerCase().trim();
  if (["female", "f", "woman", "girl", "زن", "خانم", "دختر"].includes(s)) return "female";
  if (["male", "m", "man", "boy", "مرد", "آقا", "پسر"].includes(s)) return "male";
  if (["unknown", "neutral"].includes(s)) return "unknown";
  return null;
}

/** Prompt line telling the LLM how to address the person. */
export function genderHint(g: Gender | null | undefined, who = "طرف"): string {
  if (g === "female") return `${who} خانمه: با لحن لوتی ولی محترمانه با «آبجی»، «خواهر» یا «خانم» صداش کن (یا فقط اسمش)؛ هیچ‌وقت «داداش»، «داش»، «پسر»، «آقا»، «مرد» یا تعبیرای مردونه مثل «مرد و قولش» نگو.`;
  if (g === "male") return `${who} آقاست: «داداش»، «داش» و «رفیق» اوکیه.`;
  return `جنسیت ${who} معلوم نیست: از کلمه‌های جنسیتی مثل «داداش»، «داش»، «آبجی»، «آقا»، «خانم»، «پسر»، «مرد» استفاده نکن؛ به‌جاش «رفیق» یا فقط اسمش رو بگو.`;
}

const NB = "(?<![\\p{L}\\u200c])", NA = "(?![\\p{L}\\u200c])";
const W = (w: string) => new RegExp(NB + w + NA, "gu");
/** Post-generation safety net: remove male address terms for female / unknown recipients. */
export function genderFix(text: string, g: Gender | null | undefined): string {
  if (!text || g === "male") return text;
  let t = text;
  if (g === "female") {
    t = t.replace(/مرد\s+کار\s+خودتی/g, "کارت درسته").replace(/مرد\s+و\s+قولش/g, "آدم و قولش").replace(/مرد\s+به\s+قولشه/g, "آدم به قولشه")
      .replace(/مرد\s+حرفی/g, "سر حرفتی").replace(/قول\s+مردونه/g, "قول");
    t = t.replace(/داداش(?!\s*ناصر)/g, "آبجی").replace(new RegExp(NB + "داش" + NA + "(?!\\s*ناصر)", "gu"), "آبجی").replace(W("آقا"), "خانم").replace(W("پسر"), "خانم");
    t = t.replace(/آبجی\s+آبجی/g, "آبجی").replace(/خانم\s+خانم/g, "خانم");
  } else {
    t = t.replace(/مرد\s+کار\s+خودتی/g, "کارت درسته").replace(/مرد\s+و\s+قولش/g, "آدم و قولش").replace(/مرد\s+به\s+قولشه/g, "آدم به قولشه");
    t = t.replace(/داداش(?!\s*ناصر)/g, "رفیق").replace(new RegExp(NB + "داش" + NA + "(?!\\s*ناصر)", "gu"), "رفیق").replace(new RegExp(NB + "آقا\\s+", "gu"), "");
    t = t.replace(/رفیق\s+رفیق/g, "رفیق");
  }
  return t;
}
