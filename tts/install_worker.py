#!/usr/bin/env python3
"""Install the tested Sky worker outside Documents so launchd can read it."""
import argparse
import os
from pathlib import Path
import plistlib
import shutil
import subprocess
import sys
import time
import uuid

ROOT = Path(__file__).resolve().parent
LABEL = "com.mikekonczal.stash.sky"
LEGACY = "com.mikekonczal.stash.tts"


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--user-id", required=True, type=uuid.UUID)
    parser.add_argument("--start", action="store_true", help="Start after validation and retire the old worker")
    args = parser.parse_args()
    os.umask(0o077)
    target = Path.home() / "Library/Application Support/StashAudio"
    target.mkdir(parents=True, exist_ok=True, mode=0o700)
    target.chmod(0o700)
    values = {}
    if (ROOT / ".env").exists():
        for raw in (ROOT / ".env").read_text().splitlines():
            if raw.strip() and not raw.lstrip().startswith("#") and "=" in raw:
                key, value = raw.split("=",1)
                values[key.strip()] = value.strip().strip("\"'")
    for key in ("STASH_SUPABASE_URL", "STASH_SUPABASE_SERVICE_ROLE_KEY"):
        values[key] = os.environ.get(key) or values.get(key)
        if not values[key]:
            raise RuntimeError(f"Missing {key}")
    if values["STASH_SUPABASE_URL"].rstrip("/") != "https://fvydjrhqaeemkdakqnfk.supabase.co":
        raise RuntimeError("The supplied credentials point to a different project; expected Stash")
    values["STASH_USER_ID"] = str(args.user_id)
    for key, value in values.items():
        if key.startswith("STASH_") and value and any(c in value for c in '\n\r"'):
            raise RuntimeError(f"Unexpected characters in {key}")
    # Secrets stay in a 0600 file, never in launch arguments or the plist.
    env_path = target / ".env"
    env_path.write_text("".join(f'{k}="{values[k]}"\n' for k in (
        "STASH_SUPABASE_URL", "STASH_SUPABASE_SERVICE_ROLE_KEY", "STASH_USER_ID")))
    env_path.chmod(0o600)
    for name in ("worker.py", "retention.py", "requirements-kokoro.lock"):
        shutil.copy2(ROOT / name, target / name)
    (target / "models").mkdir(exist_ok=True)
    for name in ("kokoro-v1.0.onnx", "voices-v1.0.bin"):
        source, destination = ROOT / "models" / name, target / "models" / name
        if not destination.exists() or destination.stat().st_size != source.stat().st_size:
            shutil.copy2(source, destination)
    uv = shutil.which("uv")
    if not uv:
        raise RuntimeError("uv is required to install the isolated runtime")
    python = target / ".venv/bin/python"
    cache = ["--cache-dir", "/private/tmp/stash-uv-cache"]
    if not python.exists():
        subprocess.run([uv, *cache, "venv", str(target / ".venv"), "--python", sys._base_executable], check=True)
    subprocess.run([uv, *cache, "pip", "sync", "--offline", "--python", str(python),
                    str(target / "requirements-kokoro.lock")], check=True)
    process_env = {k:v for k,v in os.environ.items() if not k.startswith("STASH_")}
    process_env["PATH"] = "/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin"
    # Check the installed copy and its own private config, not inherited values.
    subprocess.run([str(python), str(target / "worker.py"), "--check"], env=process_env, check=True)
    agent = {
        "Label": LABEL,
        "ProgramArguments": [str(python), "-u", str(target / "worker.py")],
        "WorkingDirectory": str(target),
        "EnvironmentVariables": {"PATH": process_env["PATH"]},
        "RunAtLoad": True,
        "KeepAlive": True,
        "ThrottleInterval": 60,
        # This is user-requested inference; Background can starve ONNX renders.
        "ProcessType": "Standard",
        "StandardOutPath": str(target / "worker.out.log"),
        "StandardErrorPath": str(target / "worker.err.log"),
    }
    agents = Path.home() / "Library/LaunchAgents"
    agents.mkdir(exist_ok=True)
    plist = agents / (LABEL + ".plist")
    plist.write_bytes(plistlib.dumps(agent))
    if args.start:
        domain = f"gui/{os.getuid()}"
        subprocess.run(["launchctl", "bootout", domain + "/" + LABEL], capture_output=True)
        subprocess.run(["launchctl", "enable", domain + "/" + LABEL], check=True)
        # bootout can return before launchd finishes removing a running job.
        # Wait for removal rather than racing bootstrap against that teardown.
        for _ in range(20):
            if subprocess.run(["launchctl", "print", domain + "/" + LABEL], capture_output=True).returncode != 0:
                break
            time.sleep(0.5)
        for attempt in range(5):
            started = subprocess.run(["launchctl", "bootstrap", domain, str(plist)], capture_output=True)
            if started.returncode == 0:
                break
            if attempt == 4:
                raise RuntimeError("launchd could not start the Sky worker; inspect its local job state")
            time.sleep(1)
        # Only retire the old worker after the installed worker passes --check
        # and the replacement job has been accepted by launchd.
        subprocess.run(["launchctl", "disable", domain + "/" + LEGACY], check=True)
        subprocess.run(["launchctl", "bootout", domain + "/" + LEGACY], capture_output=True)
    print(f"Installed Sky worker at {target}")
    print("Started; legacy worker disabled" if args.start else "Validated; pass --start to activate")


if __name__ == "__main__":
    main()
