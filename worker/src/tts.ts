// edge-tts (Microsoft Edge read-aloud) over an outbound WebSocket from the Worker.
// Live style "AB": phrase-by-phrase prosody on one socket, trimmed with word-boundary metadata,
// joined with silent MP3 frames. Output: MP3 24 kHz 48 kbps mono (Telegram sendVoice accepts MP3).
import { secMsGec, TRUSTED_CLIENT_TOKEN } from "./drm";

export const VOICE = "fa-IR-FaridNeural";
export const MAX_SEC = 20;
export const MAX_WORDS = 28;
const CHROMIUM = "143.0.3650.75";
const MAJOR = CHROMIUM.split(".")[0];
const FRAME = 144;            // bytes per MP3 frame (MPEG-2 L3, 24 kHz, 48 kbps, mono, no padding)
const FRAME_SEC = 0.024;      // 576 samples / 24000
const SIL_FRAME = Uint8Array.from(atob("//NkxHwAAANIAAAAAFVVVVVVVVVMQU1FMy4xMDBVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVV"), (c) => c.charCodeAt(0));

type Style = { rate: string; pitch: string; volume: string; phrases?: boolean; pause_scale?: number };
// The Python FX chain (asetrate/atempo/EQ/compressor/echo) can't run on Workers; its pitch/tempo part is folded into SSML prosody.
export const STYLES: Record<string, Style> = {
  orig: { rate: "-8%", pitch: "-6Hz", volume: "+0%" },
  A: { rate: "-6%", pitch: "-9Hz", volume: "+5%" },
  B: { rate: "-12%", pitch: "-21Hz", volume: "+5%", phrases: true, pause_scale: 1.0 },
  AB: { rate: "-8%", pitch: "-14Hz", volume: "+5%", phrases: true, pause_scale: 0.65 },
  C: { rate: "-8%", pitch: "-14Hz", volume: "+5%", phrases: true, pause_scale: 0.65 }, // piper isn't available on Workers -> AB
};

const EMOJI = /[\u{1F000}-\u{1FAFF}\u2600-\u27BF\uFE0F\u200d]+/gu;
export function speakable(text: string): string {
  let t = (text || "").replace(EMOJI, "");
  t = t.replace(/@[\p{L}\p{N}_]+|https?:\/\/\S+|[*_`#<>«»"]/gu, " ");
  t = t.split("...").join("…");
  t = t.replace(/[^\u0600-\u06FF\u200c0-9\s.!؟?،,:…]/gu, "");
  t = t.replace(/\s+/g, " ").trim();
  const words = t.split(" ").filter(Boolean);
  if (words.length > MAX_WORDS) {
    const cut = words.slice(0, MAX_WORDS).join(" ");
    const m = cut.match(/^(.*[.!؟?،…])/);
    t = (m && m[1].split(" ").filter(Boolean).length >= 8 ? m[1] : cut).replace(/[،, ]+$/u, "");
  }
  return t;
}
const shift = (v: string, d: number, unit: string) => { const n = parseInt(v.replace("+", "").replace(/[^\d-]/g, ""), 10) + d; return `${n >= 0 ? "+" : ""}${n}${unit}`; };
const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/'/g, "&apos;").replace(/"/g, "&quot;");
const ssml = (t: string, rate: string, pitch: string, vol: string) =>
  `<speak version='1.0' xmlns='http://www.w3.org/2001/10/synthesis' xml:lang='en-US'><voice name='${VOICE}'><prosody pitch='${pitch}' rate='${rate}' volume='${vol}'>${esc(t)}</prosody></voice></speak>`;
const dateStr = () => new Date().toUTCString().replace(/^(\w+), (\d+) (\w+) (\d+) (\S+) GMT$/, (_m, wd, d, mo, y, hms) => `${wd} ${mo} ${d} ${y} ${hms} GMT+0000 (Coordinated Universal Time)`);
const hex16 = () => [...crypto.getRandomValues(new Uint8Array(16))].map((x) => x.toString(16).padStart(2, "0")).join("");

type Piece = { text: string; rate: string; pitch: string; vol: string; pause: number };
export function plan(text: string, styleName: string): Piece[] {
  const st = STYLES[styleName] || STYLES.AB;
  if (!st.phrases) return [{ text, rate: st.rate, pitch: st.pitch, vol: st.volume, pause: 0 }];
  let parts = (text.match(/[^،,…!؟?.]+[،,…!؟?.]*/gu) || []).map((p) => p.trim()).filter(Boolean);
  if (parts.length <= 1) parts = [text];
  return parts.map((p, i) => {
    let rate = st.rate, pitch = st.pitch, vol = st.volume;
    if (p.endsWith("؟") || p.endsWith("?")) { pitch = shift(pitch, 6, "Hz"); rate = shift(rate, 4, "%"); }
    else if (p.endsWith("!")) { vol = shift(vol, 10, "%"); pitch = shift(pitch, -3, "Hz"); rate = shift(rate, 2, "%"); }
    else if (p.endsWith("…")) { rate = shift(rate, -6, "%"); }
    else if (i === 0 && p.split(" ").filter(Boolean).length <= 3) { rate = shift(rate, -5, "%"); pitch = shift(pitch, -2, "Hz"); }
    const base = p.endsWith("…") ? 0.38 : (p.endsWith("،") || p.endsWith(",")) ? 0.16 : 0.24;
    return { text: p, rate, pitch, vol, pause: Math.round(base * (st.pause_scale ?? 1) * 100) / 100 };
  });
}

type Clip = { audio: Uint8Array; start: number | null; end: number | null };
async function synthPieces(pieces: Piece[], timeoutMs = 30000): Promise<Clip[]> {
  const url = `https://speech.platform.bing.com/consumer/speech/synthesize/readaloud/edge/v1?TrustedClientToken=${TRUSTED_CLIENT_TOKEN}`
    + `&ConnectionId=${hex16()}&Sec-MS-GEC=${secMsGec()}&Sec-MS-GEC-Version=2-${CHROMIUM}`;
  const resp = await fetch(url, { headers: {
    Upgrade: "websocket", Pragma: "no-cache", "Cache-Control": "no-cache",
    Origin: "chrome-extension://jdiccldimpdaibmpdkjnbmckianbfold",
    "User-Agent": `Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${MAJOR}.0.0.0 Safari/537.36 Edg/${MAJOR}.0.0.0`,
    "Accept-Language": "en-US,en;q=0.9", Cookie: `muid=${hex16().toUpperCase()};`,
  } });
  const ws = (resp as any).webSocket as WebSocket | null;
  if (!ws) throw new Error(`tts ws upgrade failed: ${resp.status}`);
  ws.accept();
  const clips: Clip[] = [];
  let cur: { chunks: Uint8Array[]; start: number | null; end: number | null } = { chunks: [], start: null, end: null };
  let idx = 0;
  const sendNext = () => {
    const p = pieces[idx];
    ws.send(`X-RequestId:${hex16()}\r\nContent-Type:application/ssml+xml\r\nX-Timestamp:${dateStr()}Z\r\nPath:ssml\r\n\r\n${ssml(p.text, p.rate, p.pitch, p.vol)}`);
  };
  const done = new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => { try { ws.close(); } catch {} reject(new Error("tts timeout")); }, timeoutMs);
    ws.addEventListener("message", (ev: MessageEvent) => {
      try {
        if (typeof ev.data === "string") {
          const s = ev.data as string;
          const sep = s.indexOf("\r\n\r\n");
          const head = s.slice(0, sep);
          if (head.includes("Path:audio.metadata")) {
            const j = JSON.parse(s.slice(sep + 4));
            for (const m of j.Metadata || []) {
              if (m.Type !== "WordBoundary") continue;
              const o = m.Data.Offset / 1e7, d = m.Data.Duration / 1e7;
              if (cur.start === null) cur.start = o;
              cur.end = o + d;
            }
          } else if (head.includes("Path:turn.end")) {
            const total = cur.chunks.reduce((a, c) => a + c.length, 0);
            const audio = new Uint8Array(total); let off = 0;
            for (const c of cur.chunks) { audio.set(c, off); off += c.length; }
            clips.push({ audio, start: cur.start, end: cur.end });
            cur = { chunks: [], start: null, end: null };
            idx++;
            if (idx < pieces.length) sendNext();
            else { clearTimeout(timer); try { ws.close(1000, "done"); } catch {} resolve(); }
          }
        } else {
          const b = new Uint8Array(ev.data as ArrayBuffer);
          const hl = (b[0] << 8) | b[1];
          const head = new TextDecoder().decode(b.slice(2, 2 + hl));
          if (head.includes("Path:audio") && head.includes("Content-Type:audio/mpeg")) cur.chunks.push(b.slice(2 + hl));
        }
      } catch (e) { clearTimeout(timer); reject(e); }
    });
    ws.addEventListener("close", () => { clearTimeout(timer); if (idx < pieces.length) reject(new Error("tts socket closed early")); });
    ws.addEventListener("error", () => { clearTimeout(timer); reject(new Error("tts socket error")); });
  });
  ws.send(`X-Timestamp:${dateStr()}\r\nContent-Type:application/json; charset=utf-8\r\nPath:speech.config\r\n\r\n`
    + '{"context":{"synthesis":{"audio":{"metadataoptions":{"sentenceBoundaryEnabled":"false","wordBoundaryEnabled":"true"},"outputFormat":"audio-24khz-48kbitrate-mono-mp3"}}}}\r\n');
  sendNext();
  await done;
  return clips;
}

function frames(a: Uint8Array): Uint8Array[] {
  const out: Uint8Array[] = [];
  for (let i = 0; i + FRAME <= a.length; i += FRAME) out.push(a.subarray(i, i + FRAME));
  return out;
}

/** Returns {audio (mp3 bytes), duration seconds, spoken text} or null. */
export async function synth(text: string, style = "AB"): Promise<{ audio: Uint8Array; duration: number; spoken: string; engine: string } | null> {
  const t = speakable(text);
  if (!t) return null;
  const st = STYLES[style] ? style : "AB";
  let pieces = plan(t, st), clips: Clip[] | null = null, engine = `edge-tts:${VOICE} style=${st}`;
  try { clips = await synthPieces(pieces); } catch (e) { console.log("tts style failed", String(e)); }
  if (!clips || clips.some((c) => c.audio.length < 400)) {
    try { pieces = [{ text: t, rate: "-8%", pitch: "-6Hz", vol: "+0%", pause: 0 }]; clips = await synthPieces(pieces); engine = `edge-tts:${VOICE}(fallback)`; }
    catch (e) { console.log("tts fallback failed", String(e)); return null; }
  }
  if (!clips || !clips.length || clips.some((c) => c.audio.length < 400)) return null;
  const out: Uint8Array[] = [];
  const phrased = pieces.length > 1;
  clips.forEach((c, i) => {
    let fr = frames(c.audio);
    if (phrased && c.start !== null && c.end !== null) {   // trim leading/trailing silence (≈ ffmpeg silenceremove)
      const a = Math.max(0, Math.floor((c.start + 0.06 - 0.05) / FRAME_SEC));
      const b = Math.min(fr.length, Math.ceil((c.end + 0.06 + 0.07) / FRAME_SEC) + 1);
      if (b > a) fr = fr.slice(a, b);
    }
    out.push(...fr);
    const pause = phrased ? pieces[i].pause : 0;
    for (let k = 0; k < Math.round(pause / FRAME_SEC); k++) out.push(SIL_FRAME);
  });
  for (let k = 0; k < Math.round(0.25 / FRAME_SEC); k++) out.push(SIL_FRAME);   // apad 0.25 s
  const maxFrames = Math.floor(MAX_SEC / FRAME_SEC);
  const used = out.slice(0, maxFrames);
  const audio = new Uint8Array(used.length * FRAME);
  used.forEach((f, i) => audio.set(f, i * FRAME));
  return { audio, duration: Math.max(1, Math.round(used.length * FRAME_SEC)), spoken: t, engine };
}
