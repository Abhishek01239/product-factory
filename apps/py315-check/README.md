# Python 3.15 Readiness Check

Find the pinned dependencies that won't install from a wheel on Python 3.15, the smallest upgrade that fixes each, the APIs 3.15 removed in your code, and the CI and Docker lines that already moved to 3.15.

Live: https://abhishek01239.github.io/product-factory/py315-check/

Independent tool, not affiliated with the Python Software Foundation, PyPI or GitHub.

## Problem

Python 3.15.0 was released on 9 Oct 2026 ([What's new in 3.15](https://docs.python.org/3/whatsnew/3.15.html)). Every compiled package needs new `cp315` wheels (or `abi3`), and older releases will never get them, so a lockfile pinned before October makes pip compile numpy, pandas, pydantic-core, psycopg2-binary, PyYAML and others from source. In slim and Alpine images, which have no compiler, that fails; elsewhere it adds minutes to every build. Some packages (torch 2.12.1, ctranslate2 4.8.0 on Linux at the time of writing) have no 3.15 wheel and no sdist at all.

It arrives without anyone choosing it: the official Docker `python:3`, `latest`, `slim`, `alpine`, `bookworm` and `trixie` tags point to 3.15.0 ([official-images](https://github.com/docker-library/official-images/blob/master/library/python)), and `actions/setup-python` with `python-version: '3.x'` installs it ([manifest](https://github.com/actions/python-versions/blob/main/versions-manifest.json)).

[pyreadiness.org](https://pyreadiness.org/3.15/) shows whether the latest release of the top 360 packages declares 3.15 support (90/360 on 13 Oct 2026). What breaks a build is the version in your lockfile, on your platforms.

## What it checks

| Python 3.15 change | Detection |
|---|---|
| New ABI (`cp315`, `cp315t`, `abi3t`) | Every pinned version's real wheel files per platform (Linux glibc x86-64/ARM64, Alpine/musl, macOS arm64/x86-64, Windows x64), including `abi3`, `py3-none-<platform>` and pure-Python wheels; verdict: installs from wheel / compiles from source / can't install / not used on this platform |
| `requires-python` caps | Your `pyproject.toml` (`requires-python`, Poetry `python`) and each pinned dependency's metadata |
| Smallest fix | Lowest non-prerelease, non-yanked release newer than the pin with wheels for every selected platform that allows 3.15; patch / minor / major label; parent packages that pin the child exactly (pydantic → pydantic-core) |
| Removed APIs | `sre_compile/sre_constants/sre_parse`, `CGIHTTPRequestHandler` and `http.server --cgi`, `glob.glob0/glob1`, `platform.java_ver`, `PurePath.is_reserved`, `co_lnotab`, `ctypes.SetPointerType`, NamedTuple keyword syntax, `TypedDict("TD")`/`TypedDict("TD", None)`, `no_type_check_decorator`, wave markers, `load_module()`, `importlib.resources.files(package=)`, `sysconfig.is_python_build(check_home=)` |
| Behaviour changes | `strptime()` with `%d` and no year (ValueError), positional `sqlite3.connect()` arguments (TypeError), argparse `dest` from `-foo`, negative rlimits, `ByteString` |
| UTF-8 default (PEP 686) | `open()`, `read_text()`, `write_text()` without `encoding=` (note, mostly affects Windows) |
| `.pth` import lines (PEP 829) | `.pth` files with `import` lines |
| Floating versions | Docker `FROM`/`image:`/`container:` with `python:3`, `latest`, `slim`, `alpine`…; `python-version: '3.x'`/`>=3.x`; unquoted `3.10`; test matrices without 3.15 |

Inputs: `requirements*.txt` (pins, specifiers, markers, hashes, continuations), `uv.lock` (resolution-markers honoured; wheels read from the lock, no network needed), `poetry.lock` (files list), `pylock.toml` (PEP 751), `Pipfile.lock`, `pyproject.toml` (dependencies used only when there's no lock), `.py`, workflows, Dockerfiles, `tox.ini`, `.pth`.

Outputs: findings with file:line and fix, a per-package table, upgrade lines for requirements.txt and `uv lock --upgrade-package` / `poetry add` / `pipenv install` commands, and a Markdown checklist for an issue or PR.

## Use

- **Files**: drop or choose files (multiple at once).
- **Paste**: four text areas (dependencies, code, CI, pyproject).
- **Public GitHub repo**: `owner/repo`, a URL, or `/tree/<branch>`; also `?repo=owner/repo` deep links. Reads the file tree (2 API requests, no token), then dependency files (outside tests/docs/fixtures), workflows, Dockerfiles, `.pth` and up to 200 `.py` files (source before tests).

## Privacy and security

Static page, no backend, no analytics, no cookies. Files are analysed in the browser. PyPI lookups send only package names and versions (`/pypi/<name>/<version>/json` for pins, the Simple JSON API for upgrade search on flagged packages, max 300 + 80 requests). The CSP only allows `pypi.org`, `api.github.com` and `raw.githubusercontent.com`. All file content is rendered with `textContent`.

## Limits

- Static checks: removed-API rules are regex-based on source text (comments skipped) and can miss dynamic access or flag look-alike methods; warn-level rules say so.
- Lookups are for PyPI only; private indexes show "not found" (uv.lock and poetry.lock still work offline because they list wheel filenames).
- glibc version requirements of `manylinux_2_X` wheels are not checked against your distro.
- conda is not covered.

## Development

```
node --test apps/py315-check/tests/
python3 -m http.server -d apps 8000   # http://localhost:8000/py315-check/
```

`rules.js` is the DOM-free engine (also loadable in Node); `app.js` is the UI.
