"""Translate natural-language GitHub issues into safe factory actions."""
from __future__ import annotations
import os, subprocess, sys

title=(os.getenv("ISSUE_TITLE") or "").lower()
body=(os.getenv("ISSUE_BODY") or "").lower()
cmd=f"{title} {body}"

if any(x in cmd for x in ("find problems","find opportunities","discover problems","trending problems","find trends")):
    action=["--stage","trends"]
elif any(x in cmd for x in ("build","make product","create product","build product","ship")):
    action=["--run"]
elif "test" in cmd or "verify" in cmd:
    action=["--selftest"]
else:
    action=["--stage","trends"]

print("Factory command:", cmd[:300])
print("Mapped action:", " ".join(action))
raise SystemExit(subprocess.call([sys.executable,"agent.py",*action]))
