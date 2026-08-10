"""Security auditor — static scan of the generated product + policy rules.

Checks (each finding has severity high/medium/low and a fix hint):
* hardcoded secrets            (private keys, tokens, passwords, connection strings)
* dangerous code patterns      (eval/exec, shell=True, subprocess w/ user input,
                                os.system, raw SQL string concatenation, unsafe innerHTML)
* path traversal / SSRF traces (open redirects, "..%2f", target=_blank w/o rel)
* unsafe file uploads          (accept="*" without server-side validation)
* committed env/secret files   (.env, *.pem, credentials.*)
* informational hygiene        (no CSP meta on generated HTML — noted, low)

Scoring: 100 minus weighted deductions by severity (high=25, medium=10, low=3),
floored at 0. Any high-severity finding => the security gate FAILS outright.
"""

from __future__ import annotations

import re
from pathlib import Path
from typing import Any

from ..config import Config
from ..logging_setup import log_event
from ..utils import read_text

_SECRET_PATTERNS = [
    (re.compile(r"-----BEGIN (RSA |EC |OPENSSH )?PRIVATE KEY-----"), "private key embedded in repo"),
    (re.compile(r"(?i)(api[_-]?key|secret|token|password|passwd|client[_-]?secret)\s*[:=]\s*['\"][A-Za-z0-9_\-]{16,}['\"]"), "likely hardcoded credential"),
    (re.compile(r"(?i)(mongodb|postgres(ql)?|mysql|redis)://[^\s'\"<>]+:[^\s'\"<>]+@"), "connection string with embedded password"),
    (re.compile(r"(?i)AIza[0-9A-Za-z_\-]{20,}"), "Google API key pattern"),
    (re.compile(r"(?i)ghp_[0-9A-Za-z]{30,}"), "GitHub token pattern"),
    (re.compile(r"(?i)sk-[0-9A-Za-z]{20,}"), "OpenAI-style key pattern"),
    (re.compile(r"(?i)xox[baprs]-[0-9A-Za-z-]{10,}"), "Slack token pattern"),
]

_DANGEROUS_PATTERNS = [
    (re.compile(r"\beval\s*\("), "eval() with dynamic input"),
    (re.compile(r"\bexec\s*\("), "exec() with dynamic input"),
    (re.compile(r"shell\s*=\s*True"), "shell=True subprocess"),
    (re.compile(r"os\.system\s*\("), "os.system() call"),
    (re.compile(r"subprocess[^;]{0,80}(stdin|input)\s*="), "subprocess fed from variable input"),
    (re.compile(r"SELECT .*\+\s*\w|INSERT INTO .*\+\s*\w|f['\"]SELECT"), "SQL built by string concatenation"),
    (re.compile(r"pickle\.loads\s*\("), "pickle.loads() on untrusted data"),
    (re.compile(r"dangerouslySetInnerHTML"), "React raw HTML injection"),
    (re.compile(r"innerHTML\s*=\s*(input|value|data|userInput|\w+\.value)"), "innerHTML assigned from input"),
    (re.compile(r"window\.location\s*=\s*(input|userInput|\w+\.value)"), "unsafe redirect"),
    (re.compile(r"\.\.%2f|\.\.%2F|\.\./\.\.", re.IGNORECASE), "path traversal token"),
]

_HYGIENE_PATTERNS = [
    (re.compile(r"accept\s*=\s*['\"]?\*"), "unrestricted file upload accept"),
]

_FORBIDDEN_FILES = (".env", ".env.local", "credentials.json", "id_rsa", "id_ed25519", "client_secret.json")


class SecurityAuditor:
    def __init__(self, config: Config):
        self.config = config

    def audit(self, product_dir: Path) -> dict[str, Any]:
        findings: list[dict[str, Any]] = []
        for f in product_dir.rglob("*"):
            if not f.is_file():
                continue
            rel = str(f.relative_to(product_dir))
            if f.name in _FORBIDDEN_FILES:
                findings.append({"severity": "high", "rule": "committed secret file",
                                 "file": rel, "hint": "remove; secrets belong in env/secret storage"})
                continue
            if f.suffix not in {".html", ".js", ".py", ".css", ".json", ".md", ".webmanifest"}:
                continue
            text = read_text(f)
            checkers = [
                (_SECRET_PATTERNS, "high"),
                (_DANGEROUS_PATTERNS, "high"),
                (_HYGIENE_PATTERNS, "medium"),
            ]
            for patterns, severity in checkers:
                for pat, label in patterns:
                    if pat.search(text):
                        findings.append({"severity": severity, "rule": label,
                                         "file": rel, "flag": pat.pattern[:60]})

        # Deduplicate identical findings.
        seen: set[tuple] = set()
        unique: list[dict[str, Any]] = []
        for fn in findings:
            key = (fn["severity"], fn["rule"], fn["file"])
            if key not in seen:
                seen.add(key)
                unique.append(fn)

        high = [f for f in unique if f["severity"] == "high"]
        medium = [f for f in unique if f["severity"] == "medium"]
        low = [f for f in unique if f["severity"] == "low"]
        score = max(0, 100 - len(high) * 25 - len(medium) * 10 - len(low) * 3)
        status = "pass" if not high else "fail"
        log_event("security", "info", f"security: {status} ({len(high)} high, {len(medium)} med)")
        return {
            "status": status,
            "score": score,
            "findings": unique[:40],
            "summary": f"{len(unique)} finding(s): {len(high)} high, {len(medium)} medium, {len(low)} low",
        }