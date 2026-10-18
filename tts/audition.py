#!/usr/bin/env python3
"""Generate comparable local female-voice samples; never connects to Supabase."""

import argparse
import hashlib
import importlib.metadata
import json
from pathlib import Path
import subprocess
import time

import numpy as np
import soundfile as sf
from kokoro_onnx import Kokoro

ROOT = Path(__file__).resolve().parent
VOICES = {
    "af_heart": ("Heart", "American", "en-us"),
    "af_bella": ("Bella", "American", "en-us"),
    "af_nicole": ("Nicole", "American", "en-us"),
    "af_sarah": ("Sarah", "American", "en-us"),
    "bf_emma": ("Emma", "British", "en-gb"),
    "bf_isabella": ("Isabella", "British", "en-gb"),
    "af_alloy": ("Alloy", "American", "en-us"),
    "af_aoede": ("Aoede", "American", "en-us"),
    "af_jessica": ("Jessica", "American", "en-us"),
    "af_kore": ("Kore", "American", "en-us"),
    "af_nova": ("Nova", "American", "en-us"),
    "af_river": ("River", "American", "en-us"),
    "af_sky": ("Sky", "American", "en-us"),
    "bf_alice": ("Alice", "British", "en-gb"),
    "bf_lily": ("Lily", "British", "en-gb"),
}

# Original fictional passage, not a quotation from a published article.
PASSAGE = '''On a rainy morning in October, the neighborhood bakery opened half an hour early. A delivery driver stood by the window, watching the buses move slowly through the intersection. Inside, someone had left a newspaper beside a cooling cup of coffee.

The headline announced that inflation had fallen to 2.5 percent. But a lower inflation rate does not mean prices have returned to their old level. A sandwich that cost eight dollars before the pandemic might now cost eleven dollars and fifty cents. What matters for the customer is whether wages have caught up.

"The numbers tell one story," Maria said, "and the grocery bill tells another." In Washington, Federal Reserve officials were debating interest rates. At the bakery, the conversation had already turned to rent.'''


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--voices", nargs="+", choices=VOICES, default=list(VOICES))
    parser.add_argument("--text", type=Path, help="Optional UTF-8 passage to audition")
    parser.add_argument("--output", type=Path, default=ROOT / "auditions",
                        help="Output directory; use a new folder to preserve a previous audition")
    args = parser.parse_args()
    text = args.text.read_text() if args.text else PASSAGE
    if not text.strip():
        parser.error("The audition passage is empty")
    output = args.output.resolve()
    output.mkdir(parents=True, exist_ok=True)
    (output / "passage.txt").write_text(text + "\n")
    model = ROOT / "models" / "kokoro-v1.0.onnx"
    voices = ROOT / "models" / "voices-v1.0.bin"
    for path in (model, voices):
        if not path.is_file():
            parser.error(f"Missing model asset: {path}")
    print("Loading Kokoro on CPU...", flush=True)
    engine = Kokoro(str(model), str(voices))
    records = []
    for voice in args.voices:
        name, accent, language = VOICES[voice]
        print(f"Generating {name} ({accent})...", flush=True)
        started = time.perf_counter()
        parts = []
        sample_rate = None
        for paragraph in text.split("\n\n"):
            if not paragraph.strip():
                continue
            audio, rate = engine.create(paragraph, voice=voice, speed=1.0, lang=language)
            if sample_rate is not None and rate != sample_rate:
                raise RuntimeError("Inconsistent sample rates")
            sample_rate = rate
            if not len(audio) or not np.isfinite(audio).all():
                raise RuntimeError(f"Invalid audio for {voice}")
            if parts:
                parts.append(np.zeros(int(rate * 0.25), dtype=np.float32))
            parts.append(audio)
        audio = np.concatenate(parts)
        if float(np.max(np.abs(audio))) < 0.001:
            raise RuntimeError(f"Silent output for {voice}")
        wav = output / f"{voice}.wav"
        mp3 = output / f"{voice}.mp3"
        sf.write(wav, audio, sample_rate, subtype="PCM_16")
        subprocess.run([
            "ffmpeg", "-hide_banner", "-loglevel", "error", "-y",
            "-i", str(wav), "-codec:a", "libmp3lame", "-b:a", "96k",
            "-metadata", f"title={name} — {accent} English audition",
            str(mp3),
        ], check=True)
        elapsed = time.perf_counter() - started
        record = dict(voice=voice, name=name, accent=accent, speed=1.0,
                      duration_seconds=round(len(audio) / sample_rate, 2),
                      generation_seconds=round(elapsed, 2),
                      sample_rate=sample_rate, mp3=mp3.name)
        records.append(record)
        print(json.dumps(record), flush=True)
    metadata = dict(
        engine="kokoro-onnx",
        engine_version=importlib.metadata.version("kokoro-onnx"),
        passage_sha256=hashlib.sha256(text.encode()).hexdigest(),
        assets={path.name: hashlib.file_digest(path.open("rb"), "sha256").hexdigest()
                for path in (model, voices)},
        samples=records,
    )
    (output / "manifest.json").write_text(json.dumps(metadata, indent=2) + "\n")
    print(f"Auditions saved to {output}", flush=True)


if __name__ == "__main__":
    main()
