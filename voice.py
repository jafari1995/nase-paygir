"""Free Persian TTS for Naser with switchable styles.
orig: edge-tts FaridNeural rate-8% pitch-6Hz, no FX (what the live bot used first)
A:    edge-tts Farid, clear lūtī: rate-6% pitch-9Hz vol+5%, warm EQ + gentle compression
B:    edge-tts Farid, phrase-by-phrase prosody (questions lift, exclamations punch, pauses on …/،) + deep tough-guy FX (pitch-down, bass, compression, tiny room)
C:    piper fa_IR-gyro (local, offline, male) slightly slower + warm/deep FX
"""
import os, re, asyncio, logging, subprocess, uuid, wave
log = logging.getLogger("voice")
BASE = os.path.dirname(os.path.abspath(__file__))
VOICE = "fa-IR-FaridNeural"; MAX_SEC = 20; MAX_WORDS = 28
TMP = os.path.join(BASE, "voice_tmp"); os.makedirs(TMP, exist_ok=True)
PIPER_DIR = os.path.join(BASE, "piper")
STYLE = os.environ.get("NASER_VOICE_STYLE", "orig")   # overridden by bot (DB["voice_style"])

FX_WARM = ("equalizer=f=120:t=q:w=1:g=3,equalizer=f=320:t=q:w=1.2:g=1,equalizer=f=3500:t=q:w=1.5:g=1.5,"
           "acompressor=threshold=-18dB:ratio=3:attack=10:release=150:makeup=2,loudnorm=I=-16:TP=-1.5:LRA=9")
def FX_DEEP(sr):
    return (f"asetrate={int(sr*0.90)},aresample={sr},atempo=1.05,"
            "equalizer=f=105:t=q:w=1:g=5,equalizer=f=240:t=q:w=1:g=2,equalizer=f=2800:t=q:w=1.5:g=2.5,"
            "acompressor=threshold=-21dB:ratio=4:attack=5:release=120:makeup=3,"
            "aecho=0.85:0.6:28|55:0.14|0.07,loudnorm=I=-16:TP=-1.5:LRA=8")
def FX_PIPER(sr):
    return (f"asetrate={int(sr*0.96)},aresample={sr},atempo=1.0,"
            "equalizer=f=115:t=q:w=1:g=4,equalizer=f=3000:t=q:w=1.5:g=2,"
            "acompressor=threshold=-20dB:ratio=3.5:attack=8:release=130:makeup=2,"
            "aecho=0.85:0.6:25|50:0.10|0.05,loudnorm=I=-16:TP=-1.5:LRA=8")

def FX_AB(sr):
    return (f"asetrate={int(sr*0.95)},aresample={sr},atempo=1.03,"
            "equalizer=f=110:t=q:w=1:g=4,equalizer=f=260:t=q:w=1.2:g=1.5,equalizer=f=3200:t=q:w=1.5:g=2,"
            "acompressor=threshold=-19dB:ratio=3:attack=8:release=140:makeup=2,"
            "aecho=0.9:0.7:20:0.05,loudnorm=I=-16:TP=-1.5:LRA=9")

STYLES = {
    "orig": {"engine": "edge", "rate": "-8%", "pitch": "-6Hz", "volume": "+0%", "fx": None},
    "A": {"engine": "edge", "rate": "-6%", "pitch": "-9Hz", "volume": "+5%", "fx": lambda sr: "silenceremove=stop_periods=-1:stop_duration=0.4:stop_threshold=-45dB:stop_silence=0.35," + FX_WARM},
    "B": {"engine": "edge", "phrases": True, "rate": "-7%", "pitch": "-10Hz", "volume": "+5%", "fx": FX_DEEP},
    "AB": {"engine": "edge", "phrases": True, "pause_scale": 0.65, "rate": "-6%", "pitch": "-9Hz", "volume": "+5%", "fx": FX_AB},
    "C": {"engine": "piper", "model": "fa_IR-gyro-medium", "length_scale": 1.08, "noise_scale": 0.72, "noise_w": 0.9, "fx": FX_PIPER},
}

# Prompt add-on for writing lines meant to be spoken (used for styles A/B/C)
SPOKEN_HINT = ("نکات گفتاری: کاملاً شکسته و محاوره‌ای بنویس (میدی، می‌خوای، دیگه، داداش)، جمله‌های کوتاه و تیکه‌تیکه، "
               "با «،» و «…» برای مکث و «!» برای تأکید؛ از تیکه‌های لوتی مثل «داداش»، «نوکرتم»، «مرام»، «معرفت»، «دمت گرم»، «قربون مرامت» استفاده کن؛ "
               "بدون ایموجی، بدون عدد انگلیسی، مثل یه داش‌مشتیِ با حوصله که پشت تلفن داره حرف می‌زنه.")

EMOJI = re.compile("[\U0001F000-\U0001FAFF\u2600-\u27BF\uFE0F\u200d]+")
def speakable(text):
    t = EMOJI.sub("", text or "")
    t = re.sub(r"@\w+|https?://\S+|[*_`#<>«»\"]", " ", t)
    t = t.replace("...", "…")
    t = re.sub(r"[^\u0600-\u06FF\u200c0-9\s.!؟?،,:…]", "", t)
    t = re.sub(r"\s+", " ", t).strip()
    words = t.split()
    if len(words) > MAX_WORDS:
        cut = " ".join(words[:MAX_WORDS])
        m = re.search(r"^(.*[.!؟?،…])", cut)
        t = (m.group(1) if m and len(m.group(1).split()) >= 8 else cut).rstrip("،, ")
    return t

def _run(cmd, timeout=60):
    r = subprocess.run(cmd, capture_output=True, timeout=timeout)
    if r.returncode != 0: log.warning("cmd failed: %s", r.stderr[-300:])
    return r.returncode == 0

async def _edge(text, out, rate, pitch, volume):
    import edge_tts
    await asyncio.wait_for(edge_tts.Communicate(text, VOICE, rate=rate, pitch=pitch, volume=volume).save(out), 40)
    return os.path.exists(out) and os.path.getsize(out) > 800

def _shift(v, d, unit):
    n = int(re.sub(r"[^\d-]", "", v.replace("+", ""))) + d
    return f"{'+' if n >= 0 else ''}{n}{unit}"

async def _edge_phrases(text, wav_out, st):
    """Synthesize phrase-by-phrase with varied prosody, then join with natural pauses."""
    parts = re.findall(r"[^،,…!؟?.]+[،,…!؟?.]*", text)
    parts = [p.strip() for p in parts if p.strip()]
    if len(parts) <= 1: parts = [text]
    pieces = []
    for i, p in enumerate(parts):
        rate, pitch, vol = st["rate"], st["pitch"], st["volume"]
        if p.endswith(("؟", "?")): pitch = _shift(pitch, +6, "Hz"); rate = _shift(rate, +4, "%")
        elif p.endswith("!"): vol = _shift(vol, +10, "%"); pitch = _shift(pitch, -3, "Hz"); rate = _shift(rate, +2, "%")
        elif p.endswith("…"): rate = _shift(rate, -6, "%")
        elif i == 0 and len(p.split()) <= 3: rate = _shift(rate, -5, "%"); pitch = _shift(pitch, -2, "Hz")  # «رضا داش،» drawn out
        mp3 = os.path.join(TMP, uuid.uuid4().hex + ".mp3"); wav = mp3[:-4] + ".wav"
        if not await _edge(p, mp3, rate, pitch, vol): return False
        _run(["ffmpeg", "-y", "-loglevel", "error", "-i", mp3, "-ar", "24000", "-ac", "1",
              "-af", "silenceremove=start_periods=1:start_threshold=-45dB,areverse,silenceremove=start_periods=1:start_threshold=-45dB,areverse", wav])
        os.remove(mp3)
        pause = round((0.38 if p.endswith("…") else 0.16 if p.endswith(("،", ",")) else 0.24) * st.get("pause_scale", 1.0), 2)
        pieces.append((wav, pause))
    lst = os.path.join(TMP, uuid.uuid4().hex + ".txt")
    sil = {}
    with open(lst, "w") as f:
        for wav, pause in pieces:
            f.write(f"file '{wav}'\n")
            if pause not in sil:
                sil[pause] = os.path.join(TMP, f"sil_{int(pause*1000)}.wav")
                if not os.path.exists(sil[pause]):
                    _run(["ffmpeg", "-y", "-loglevel", "error", "-f", "lavfi", "-i", "anullsrc=r=24000:cl=mono", "-t", str(pause), sil[pause]])
            f.write(f"file '{sil[pause]}'\n")
    ok = _run(["ffmpeg", "-y", "-loglevel", "error", "-f", "concat", "-safe", "0", "-i", lst, "-c:a", "pcm_s16le", wav_out])
    for wav, _ in pieces: os.remove(wav)
    os.remove(lst)
    return ok

_piper_cache = {}
def _piper(text, wav_out, st):
    from piper import PiperVoice, SynthesisConfig
    v = _piper_cache.get(st["model"])
    if v is None:
        v = _piper_cache[st["model"]] = PiperVoice.load(os.path.join(PIPER_DIR, st["model"] + ".onnx"))
    cfg = SynthesisConfig(length_scale=st["length_scale"], noise_scale=st["noise_scale"], noise_w_scale=st["noise_w"])
    with wave.open(wav_out, "wb") as w:
        v.synthesize_wav(text.replace("…", "،"), w, syn_config=cfg)
    return os.path.getsize(wav_out) > 2000

def _rate(path):
    try:
        out = subprocess.run(["ffprobe", "-v", "error", "-select_streams", "a:0", "-show_entries", "stream=sample_rate", "-of", "csv=p=0", path],
                             capture_output=True, text=True, timeout=20).stdout.strip()
        return int(out)
    except Exception: return 24000

def duration(path):
    try:
        out = subprocess.run(["ffprobe", "-v", "error", "-show_entries", "format=duration", "-of", "csv=p=0", path],
                             capture_output=True, text=True, timeout=20).stdout.strip()
        return float(out)
    except Exception: return None

async def render(text, style=None):
    """Return (raw_audio_path, engine_label) for the style (no FX yet)."""
    style = style if style in STYLES else (STYLE if STYLE in STYLES else "orig")
    st = STYLES[style]; base = os.path.join(TMP, uuid.uuid4().hex)
    try:
        if st["engine"] == "piper":
            wav = base + ".wav"
            if await asyncio.to_thread(_piper, text, wav, st): return wav, f"piper:{st['model']}", style
        elif st.get("phrases"):
            wav = base + ".wav"
            if await _edge_phrases(text, wav, st): return wav, f"edge-tts:{VOICE}(phrases)", style
        else:
            mp3 = base + ".mp3"
            if await _edge(text, mp3, st["rate"], st["pitch"], st["volume"]): return mp3, f"edge-tts:{VOICE}", style
    except Exception as e:
        log.warning("style %s failed: %s", style, e)
    # fallbacks: plain edge, then local piper
    try:
        mp3 = base + "_fb.mp3"
        if await _edge(text, mp3, "-8%", "-6Hz", "+0%"): return mp3, f"edge-tts:{VOICE}(fallback)", "orig"
    except Exception as e:
        log.warning("edge fallback failed: %s", e)
    try:
        wav = base + "_fb.wav"
        if await asyncio.to_thread(_piper, text, wav, STYLES["C"]): return wav, "piper:gyro(fallback)", "C"
    except Exception as e:
        log.warning("piper fallback failed: %s", e)
    return None, None, None

async def synth(text, out_ogg=None, keep_mp3=None, style=None):
    """Return (ogg_path, engine, spoken_text) or (None, None, text). keep_mp3 saves an mp3 preview."""
    t = speakable(text)
    if not t: return None, None, t
    raw, engine, used = await render(t, style)
    if not raw: return None, None, t
    fxf = STYLES[used]["fx"]
    trim = "silenceremove=start_periods=1:start_threshold=-45dB,areverse,silenceremove=start_periods=1:start_threshold=-45dB,areverse,"
    af = (trim + fxf(_rate(raw)) + ",apad=pad_dur=0.25") if fxf else None
    ogg = out_ogg or os.path.join(TMP, uuid.uuid4().hex + ".ogg")
    cmd = ["ffmpeg", "-y", "-loglevel", "error", "-i", raw]
    if af: cmd += ["-af", af]
    ok = await asyncio.to_thread(_run, cmd + ["-t", str(MAX_SEC), "-ac", "1", "-ar", "48000", "-c:a", "libopus", "-b:a", "40k", "-application", "voip", ogg])
    if keep_mp3:
        await asyncio.to_thread(_run, cmd + ["-t", str(MAX_SEC), "-ac", "1", "-ar", "44100", "-c:a", "libmp3lame", "-b:a", "128k", keep_mp3])
    try: os.remove(raw)
    except Exception: pass
    return (ogg if ok else None), f"{engine} style={used}", t
