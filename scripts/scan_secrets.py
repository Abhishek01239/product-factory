"""Scan the repository for committed secrets — the CI secrets gate.

Usage:
    python scripts/scan_secrets.py            # scan whole repo, exit 1 on findings
    python scripts/scan_secrets.py --json     # machine-readable findings

Checks (documented, deterministic — no ML, no network):
  1. Committed .env / credential files (any ``.env*`` except ``.env.example``).
  2. Private key blocks.
  3. Credential idioms: ``KEY=value`` / ``"key": "value"`` / ``Authorization: ...``
     where the key is a known credential name and the value is a literal
     (NOT ``os.environ[...]``, ``$VAR``, ``${{ secrets.X }}`` placeholders).

Runtime dirs (runs/, workspace/, products/, logs/) are never scanned:
they are gitignored and may legitimately contain build output.
"""

from __future__ import annotations

import argparse
import json
import re
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
EXCLUDE_DIRS = {".git", "runs", "workspace", "products", "logs", "__pycache__", ".venv", "venv"}
SCAN_SUFFIXES = {".json", ".yml", ".yaml", ".toml", ".ini", ".cfg", ".txt", ".md", ".sh",
                 ".py", ".js", ".ts", ".html", ".css", ".env"}

_CREDENTIAL_KEYWORDS = (
    r"api[_-]?key", r"client[_-]?secret", r"client[_-]?id", r"app[_-]?password",
    r"access[_-]?token", r"refresh[_-]?token", r"auth[_-]?token", r"bot[_-]?token",
    r"authorization", r"bearer", r"token", r"secret", r"password", r"private[_-]?key",
)
# KEY: "literal-value" — literal means no env/template/format markers.
_SNIPPET_RE = re.compile(
    rf"(?i)\b(?:{'|'.join(_CREDENTIAL_KEYWORDS)})\b\s*[:=]\s*(?:bearer\s+)?"
    rf"(['\"]?)([A-Za-z0-9_\-\.\/+~]{{12,}})\1",
)
_PRIVATE_KEY_RE = re.compile(r"-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----")

# Values that appear ONLY as deliberate test fixtures (never real credentials).
_ALLOWED_VALUES = ("supersecretvalue123", "sk-abc123", "abcd1234xy")


def scan_file(path: Path) -> list[dict]:
    try:
        text = path.read_text(encoding="utf-8", errors="replace")
    except OSError:
        return []
    findings: list[dict] = []
    for m in _SNIPPET_RE.finditer(text):
        value = m.group(2)
        # Placeholders / code references / test sentinels are not secrets.
        if value.startswith(("$", "{{", "os.environ", "environ", "getenv", "env[",
                             "os.getenv", "process.env", "secrets.", "config(")):
            continue
        if value in _ALLOWED_VALUES:
            continue
        findings.append({
            "file": str(path.relative_to(ROOT)),
            "rule": "credential idiom with literal value",
            "match": value[:8] + "…",
            "severity": "high",
        })
    for m in _PRIVATE_KEY_RE.finditer(text):
        findings.append({
            "file": str(path.relative_to(ROOT)),
            "rule": "private key block",
            "match": "-----BEGIN … PRIVATE KEY-----",
            "severity": "critical",
        })
    return findings


def scan_tree(root: Path = ROOT) -> list[dict]:
    findings: list[dict] = []
    for f in root.rglob("*"):
        if not f.is_file():
            continue
        rel = f.relative_to(root)
        if any(part in EXCLUDE_DIRS for part in rel.parts):
            continue
        if f.name == ".env.example":
            continue  # documented template — no real values
        if f.name.startswith(".env") or f.suffix == ".pem" or f.name.startswith("id_rsa") \
                or f.name.startswith("id_ed25519"):
            findings.append({
                "file": str(rel), "rule": "forbidden credential file", "match": f.name,
                "severity": "critical",
            })
            continue
        if f.suffix in SCAN_SUFFIXES or f.name in {"Dockerfile", "docker-compose.yml"}:
            findings.extend(scan_file(f))
    return findings


def main() -> int:
    ap = argparse.ArgumentParser(description="Repo secret scan (CI gate).")
    ap.add_argument("--json", action="store_true")
    args = ap.parse_args()

    findings = scan_tree()
    by_severity: dict[str, int] = {}
    for f in findings:
        by_severity[f["severity"]] = by_severity.get(f["severity"], 0) + 1

    template = ROOT / ".env.example"
    if not template.exists():
        findings.append({"file": ".env.example", "rule": "missing env template",
                         "match": "add .env.example", "severity": "medium"})

    if args.json:
        print(json.dumps({"findings": findings, "counts": by_severity}, indent=2))
    else:
        for f in findings:
            print(f"[{f['severity']}] {f['file']}: {f['rule']} ({f['match']})")
        print(f"scan complete: {len(findings)} finding(s) "
              f"(critical={by_severity.get('critical', 0)}, "
              f"high={by_severity.get('high', 0)}, medium={by_severity.get('medium', 0)})")

    # CI gate: any critical/high finding fails the scan.
    return 1 if (by_severity.get("critical", 0) or by_severity.get("high", 0)) else 0


if __name__ == "__main__":
    sys.exit(main())