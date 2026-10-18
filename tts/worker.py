#!/usr/bin/env python3
"""Durable, local Sky generation. No paid speech API or Git operations."""
from __future__ import annotations

import argparse
import contextlib
import fcntl
import hashlib
from html.parser import HTMLParser
import json
import logging
import os
from pathlib import Path
import re
import shutil
import signal
import subprocess
import sys
import threading
import time
from urllib import error, request
import uuid

ROOT = Path(__file__).resolve().parent
VOICE = "af_sky"
PIPELINE_VERSION = "sky-v1-kokoro-onnx-0.6.1-espeak"
CHUNK_TIMEOUT = 180
POLL_SECONDS = 20
STORAGE_BUDGET = 950_000_000  # Leave headroom below the free 1 GB allowance.
LOG = logging.getLogger("stash.audio")


class LeaseLost(RuntimeError):
    pass


class HtmlText(HTMLParser):
    def __init__(self):
        super().__init__()
        self.parts = []
        self.skip = 0

    def handle_starttag(self, tag, attrs):
        if tag in {"script", "style"}:
            self.skip += 1
        if tag in {"p", "div", "br", "li", "h1", "h2", "h3", "blockquote"}:
            self.parts.append("\n\n")

    def handle_endtag(self, tag):
        if tag in {"script", "style"}:
            self.skip = max(0, self.skip - 1)
        if tag in {"p", "div", "li", "blockquote"}:
            self.parts.append("\n\n")

    def handle_data(self, data):
        if not self.skip:
            self.parts.append(data)


def clean_text(content: str, title: str = "") -> str:
    """Remove presentation markup, retaining the full article (no word cutoff)."""
    text = re.sub(r"!\[[^\]]*\]\([^)]*\)", "", content)
    text = re.sub(r"\[([^\]]+)\]\([^)]*\)", r"\1", text)
    if re.search(r"</?(?:p|div|article|br|strong|em|h[1-6])(?:\s|>)", text):
        parser = HtmlText()
        parser.feed(text)
        text = "".join(parser.parts)
    text = re.sub(r"^\s{0,3}#{1,6}\s+", "", text, flags=re.M)
    text = re.sub(r"^\s*(?:---+|\*\*\*+)\s*$", "", text, flags=re.M)
    text = re.sub(r"^\s*>\s?", "", text, flags=re.M)
    text = text.replace("**", "").replace("__", "").replace("```", "").replace("`", "")
    text = re.sub(r"[ \t]+", " ", text)
    text = re.sub(r"\n{3,}", "\n\n", text).strip()
    if not text:
        raise ValueError("The article has no readable text")
    return (title.strip() + ".\n\n" if title.strip() else "") + text


def split_text(text: str, limit: int = 550) -> list[str]:
    """Prefer sentence boundaries; split unusually long sentences at words."""
    chunks = []
    for paragraph in re.split(r"\n\s*\n", text):
        current = ""
        for sentence in re.split(r"(?<=[.!?])\s+", paragraph.strip()):
            for word in sentence.split():
                # Splitting on whitespace preserves every word, including a
                # single token longer than the limit; the runtime splits phonemes.
                if current and len(current) + len(word) + 1 > limit:
                    chunks.append(current)
                    current = ""
                current = (current + " " + word).strip()
            if len(current) >= limit * 0.6:
                chunks.append(current)
                current = ""
        if current:
            chunks.append(current)
    if not chunks:
        raise ValueError("The article has no readable text")
    return chunks


def wav_valid(path: Path) -> bool:
    import numpy as np
    import soundfile as sf
    try:
        audio, rate = sf.read(path, dtype="float32")
        return rate == 24000 and audio.ndim == 1 and len(audio) > 2400 and bool(
            np.isfinite(audio).all() and np.max(np.abs(audio)) > 0.001)
    except (OSError, RuntimeError, ValueError):
        return False


def render_chunk(input_file: Path, output_file: Path):
    import numpy as np
    import soundfile as sf
    from kokoro_onnx import Kokoro
    data = json.loads(input_file.read_text())
    model = Kokoro(str(ROOT / "models/kokoro-v1.0.onnx"), str(ROOT / "models/voices-v1.0.bin"))
    samples, rate = model.create(data["text"], voice=VOICE, speed=1.0, lang="en-us")
    if not len(samples) or not np.isfinite(samples).all() or np.max(np.abs(samples)) < 0.001:
        raise RuntimeError("Kokoro returned empty or silent audio")
    partial = output_file.with_suffix(".partial.wav")
    sf.write(partial, samples, rate, subtype="PCM_16")
    partial.replace(output_file)


def generate_recording(content: str, title: str, cache: Path, progress=lambda done, total: None) -> Path:
    import soundfile as sf
    import numpy as np
    text = clean_text(content, title)
    chunks = split_text(text)
    digest = hashlib.sha256((PIPELINE_VERSION + "\n" + text).encode()).hexdigest()
    work = cache / digest
    work.mkdir(parents=True, exist_ok=True, mode=0o700)
    if shutil.disk_usage(work).free < 1024**3:
        raise RuntimeError("Less than 1 GB of free disk space remains on this Mac")
    progress(0, len(chunks))
    for index, chunk in enumerate(chunks):
        wav = work / f"{index:05}.wav"
        if not wav_valid(wav):
            source = work / f"{index:05}.json"
            source.write_text(json.dumps({"text": chunk}))
            # The render subprocess needs no database credentials. A hard
            # timeout can kill a stuck inference without wedging the worker.
            env = {k: v for k, v in os.environ.items() if not k.startswith("STASH_SUPABASE")}
            try:
                result = subprocess.run(
                    [sys.executable, str(Path(__file__).resolve()), "--render-chunk", str(source), str(wav)],
                    env=env, capture_output=True, timeout=CHUNK_TIMEOUT,
                )
            except subprocess.TimeoutExpired as exc:
                raise RuntimeError("A section exceeded the three-minute generation limit") from exc
            if result.returncode != 0 or not wav_valid(wav):
                (work / "render-error.log").write_bytes(result.stderr[-16000:])
                # Do not expose article text or inherited process diagnostics.
                LOG.error("Render diagnostics: %s", work / "render-error.log")
                raise RuntimeError(f"Could not generate section {index + 1}. Retry to resume saved sections.")
        progress(index + 1, len(chunks))
    combined = work / "combined.wav"
    with sf.SoundFile(combined, mode="w", samplerate=24000, channels=1, subtype="PCM_16") as out:
        for index in range(len(chunks)):
            if index:
                out.write(np.zeros(6000, dtype=np.float32))
            samples, _ = sf.read(work / f"{index:05}.wav", dtype="float32")
            out.write(samples)
    mp3 = work / "audio.mp3"
    subprocess.run(["ffmpeg", "-hide_banner", "-loglevel", "error", "-y", "-i", str(combined),
                    "-codec:a", "libmp3lame", "-b:a", "64k", str(mp3)], check=True, timeout=180,
                   stdout=subprocess.DEVNULL, stderr=subprocess.PIPE)
    combined.unlink()
    if mp3.stat().st_size < 1000:
        raise RuntimeError("Generated MP3 is empty")
    return mp3


def load_config():
    env = ROOT / ".env"
    if env.exists():
        for raw in env.read_text().splitlines():
            line = raw.strip()
            if line and not line.startswith("#") and "=" in line:
                key, value = line.split("=", 1)
                os.environ.setdefault(key.strip(), value.strip().strip("\"'"))
    for name in ("STASH_SUPABASE_URL", "STASH_SUPABASE_SERVICE_ROLE_KEY", "STASH_USER_ID"):
        if not os.environ.get(name):
            raise RuntimeError(f"Missing {name}; run the worker installer before starting")
    uuid.UUID(os.environ["STASH_USER_ID"])
    if not os.environ["STASH_SUPABASE_URL"].startswith("https://"):
        raise RuntimeError("STASH_SUPABASE_URL must use HTTPS")
    if os.environ["STASH_SUPABASE_SERVICE_ROLE_KEY"].startswith("sb_publishable_"):
        raise RuntimeError("The worker needs the service-role key")


class Supabase:
    def __init__(self):
        self.url = os.environ["STASH_SUPABASE_URL"].rstrip("/")
        self.key = os.environ["STASH_SUPABASE_SERVICE_ROLE_KEY"]
        self.user = os.environ["STASH_USER_ID"]

    def call(self, path, data=None, *, method="POST", headers=None, raw=False, timeout=30):
        body = data if raw else (json.dumps(data).encode() if data is not None else None)
        req = request.Request(self.url + path, data=body, method=method, headers={
            "apikey": self.key, "Authorization": f"Bearer {self.key}",
            "Content-Type": "application/json", **(headers or {}),
        })
        try:
            with request.urlopen(req, timeout=timeout) as res:
                payload = res.read()
                return json.loads(payload) if payload else None
        except error.HTTPError as exc:
            raise RuntimeError(f"Supabase request failed (HTTP {exc.code})") from None
        except (error.URLError, TimeoutError, OSError):
            raise RuntimeError("Could not connect to Supabase; check this Mac's connection") from None

    def rpc(self, name, **args):
        return self.call("/rest/v1/rpc/" + name, args)

    def heartbeat(self):
        self.call("/rest/v1/audio_workers?on_conflict=user_id", {
            "user_id": self.user, "last_seen": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())},
            headers={"Prefer": "resolution=merge-duplicates,return=minimal"})


class JobLease:
    def __init__(self, api, job, token):
        self.api, self.job, self.token = api, job, token
        self.done, self.total = 0, 0
        self.stopped = threading.Event()
        self.lost = threading.Event()
        self.lock = threading.Lock()
        self.thread = threading.Thread(target=self.loop, daemon=True)
        self.confirmed = time.monotonic()

    def renew(self):
        with self.lock:
            valid = self.api.rpc("renew_stash_audio", p_job_id=self.job["id"], p_token=self.token,
                                 p_completed=self.done, p_total=self.total)
            if not valid:
                self.lost.set()
                raise LeaseLost("This job was reclaimed; stopping the old worker")
            self.confirmed = time.monotonic()

    def progress(self, done, total):
        if self.lost.is_set():
            raise LeaseLost("The job lease expired")
        self.done, self.total = done, total
        self.renew()

    def loop(self):
        while not self.stopped.wait(20):
            try:
                self.renew()
                self.api.heartbeat()
            except LeaseLost:
                return
            except Exception:
                LOG.warning("Heartbeat could not reach Supabase")
                if time.monotonic() - self.confirmed > 540:
                    self.lost.set()
                    return

    def __enter__(self):
        self.thread.start()
        return self

    def __exit__(self, *args):
        self.stopped.set()
        self.thread.join(timeout=35)


def process_job(api, job, token, state):
    with JobLease(api, job, token) as lease:
        path = generate_recording(job["source_content"], job["title"], state / "cache" / job["id"], lease.progress)
        lease.renew()
        object_name = f"{api.user}/{job['id']}.mp3"
        used = api.rpc("stash_audio_storage_bytes", p_object=object_name)
        if used + path.stat().st_size > STORAGE_BUDGET:
            raise RuntimeError("Audio storage is near its free limit. Free storage space, then retry this article.")
        if path.stat().st_size > 50_000_000:
            raise RuntimeError("This recording exceeds the free storage service's 50 MB file limit.")
        api.call("/storage/v1/object/stash-audio/" + object_name, path.read_bytes(),
                 headers={"Content-Type": "audio/mpeg", "x-upsert": "true"}, raw=True, timeout=120)
        lease.renew()
        if not api.rpc("finish_stash_audio", p_job_id=job["id"], p_token=token,
                       p_audio_url="storage://stash-audio/" + object_name):
            raise LeaseLost("Completion rejected because this worker no longer owns the job")
        # Only delete local checkpoints after the database confirms completion.
        shutil.rmtree(state / "cache" / job["id"], ignore_errors=True)
        LOG.info("Audio ready for save %s (%s sections)", job["save_id"], lease.total)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--once", action="store_true", help="Process at most one queued job, then exit")
    parser.add_argument("--check", action="store_true", help="Validate config and database access without processing")
    parser.add_argument("--local-file", type=Path, help="Generate locally without database credentials")
    parser.add_argument("--output", type=Path, default=ROOT / "auditions/sky-full.mp3")
    parser.add_argument("--render-chunk", nargs=2, type=Path, metavar=("INPUT_JSON", "OUTPUT_WAV"))
    args = parser.parse_args()
    os.umask(0o077)
    logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")
    if args.render_chunk:
        render_chunk(*args.render_chunk)
        return
    for file in (ROOT / "models/kokoro-v1.0.onnx", ROOT / "models/voices-v1.0.bin"):
        if not file.is_file():
            raise RuntimeError("Missing Kokoro models; see KOKORO.md")
    if not shutil.which("ffmpeg"):
        raise RuntimeError("ffmpeg is not installed or not on PATH")
    if args.local_file:
        started = time.monotonic()
        result = generate_recording(args.local_file.read_text(), "", ROOT / "auditions/local-cache",
                                    lambda done, total: LOG.info("Sections: %s/%s", done, total))
        args.output.parent.mkdir(parents=True, exist_ok=True)
        shutil.copyfile(result, args.output)
        LOG.info("Saved %s in %.1f seconds", args.output, time.monotonic() - started)
        return
    load_config()
    api = Supabase()
    # Explicit select catches a missing migration, bad credentials, and bad user
    # configuration before declaring this worker healthy.
    api.call("/rest/v1/audio_jobs?select=id&limit=1", method="GET")
    api.call("/rest/v1/audio_deletions?select=id&limit=1", method="GET")
    users = api.call(f"/auth/v1/admin/users/{api.user}", method="GET")
    if not users or users.get("id") != api.user:
        raise RuntimeError("STASH_USER_ID does not identify an existing user")
    if args.check:
        LOG.info("Worker configuration and audio queue access verified")
        return
    state = Path(os.environ.get("STASH_AUDIO_STATE_DIR", str(ROOT / "state")))
    state.mkdir(parents=True, exist_ok=True, mode=0o700)
    stop = threading.Event()
    signal.signal(signal.SIGTERM, lambda *_: stop.set())
    signal.signal(signal.SIGINT, lambda *_: stop.set())
    with (state / "worker.lock").open("w") as lock:
        try:
            fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError:
            raise RuntimeError("Another Sky worker is already running") from None
        next_cleanup = 0
        while not stop.is_set():
            job, token = None, str(uuid.uuid4())
            try:
                api.heartbeat()
                if time.monotonic() >= next_cleanup:
                    from retention import cleanup_expired_audio
                    try:
                        cleanup_expired_audio(api)
                        next_cleanup = time.monotonic() + 3600
                    except Exception:
                        # Cleanup failures must not block synthesis or lose
                        # the durable deletion outbox. Retry in one minute.
                        LOG.warning('Audio retention could not finish; will retry')
                        next_cleanup = time.monotonic() + 60
                jobs = api.rpc("claim_stash_audio", p_user_id=api.user, p_token=token)
                if jobs:
                    job = jobs[0]
                    LOG.info("Generating Sky audio for save %s (attempt %s)", job["save_id"], job["attempts"])
                    process_job(api, job, token, state)
            except Exception as exc:
                # Exceptions deliberately exclude request headers/bodies and text.
                message = str(exc) if isinstance(exc, (RuntimeError, ValueError)) else type(exc).__name__
                LOG.error("Audio worker: %s", message)
                if job and not isinstance(exc, LeaseLost):
                    with contextlib.suppress(Exception):
                        api.rpc("fail_stash_audio", p_job_id=job["id"], p_token=token, p_error=message)
                if args.once:
                    raise SystemExit(1)
            if args.once:
                return
            # Drain ready jobs immediately; otherwise wake every 20 seconds.
            if not job:
                stop.wait(POLL_SECONDS)


if __name__ == "__main__":
    try:
        main()
    except Exception as exc:
        LOG.error("Startup failed: %s", str(exc) if isinstance(exc, (RuntimeError, ValueError)) else type(exc).__name__)
        raise SystemExit(1)
