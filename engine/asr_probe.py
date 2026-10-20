"""Acoustic word-timestamp probe, never used as canonical display lyrics."""
import json
import os
from pathlib import Path
import time
import sys
import truststore
truststore.inject_into_ssl()
os.environ.setdefault("HF_HUB_DISABLE_XET", "1")
import soundfile as sf
from faster_whisper import WhisperModel
data = Path(__file__).resolve().parent.parent / ".studio-data" / "verification"
started = time.monotonic()
full = "--full" in sys.argv
if full:
    import subprocess
    subprocess.run(["ffmpeg","-loglevel","error","-y","-i",str(data/"twinkle-full.ogg"),
        "-ac","1","-ar","16000",str(data/"twinkle-full.wav")],check=True)
audio, sr = sf.read(data / ("twinkle-full.wav" if full else "twinkle-short.wav"), dtype="float32")
model = WhisperModel("small", device="cpu", compute_type="int8", cpu_threads=4)
segments, _ = model.transcribe(audio, word_timestamps=True, beam_size=5,
    vad_filter=False, condition_on_previous_text=False)
words = [{"text":w.word,"start_time":w.start,"end_time":w.end,"probability":w.probability}
    for s in segments for w in s.words]
result = {"words":words,"elapsedSeconds":time.monotonic()-started}
(data / ("full-asr.json" if full else "short-asr.json")).write_text(json.dumps(result,indent=2),encoding="utf-8")
print(json.dumps(result),flush=True)
