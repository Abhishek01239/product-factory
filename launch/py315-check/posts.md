# Launch drafts: Python 3.15 Readiness Check

Status: DRAFT, NOT PUBLISHED (no social accounts connected: X, Bluesky, Facebook Pages, Mastodon, Threads, LinkedIn are disconnected).
Publish only after the live URL is verified. Image: `og.png` (1200x630, same as the site's social card).
URL: https://abhishek01239.github.io/product-factory/py315-check/

Angle: useful first. Lead with "your CI may already be on 3.15" and the concrete pins that lack wheels; the tool comes last. All numbers below were checked against PyPI on 2026-10-13.

## X (thread)

1/ Python 3.15 shipped on Oct 9. If your CI uses `python-version: '3.x'` or a Dockerfile says `FROM python:3-slim`, you're already on it.

2/ The usual first failure isn't your code. It's a pinned dependency with no cp315 wheel, so pip tries to compile it. In a slim image there's no compiler.

3/ Where 3.15 wheels start (PyPI, Oct 13):
- numpy 2.5.2
- pandas 3.0.6
- psycopg2-binary 2.9.13
- PyYAML: no 3.15 wheels yet
A lockfile from the spring has none of these.

4/ Also removed in 3.15: sre_* modules, CGIHTTPRequestHandler, glob0/glob1, co_lnotab. And strptime('%d %b') with no year now raises ValueError.

5/ I made a free checker: drop in requirements.txt / uv.lock / poetry.lock or a public repo. It reads the real wheel files for your pins on Linux/macOS/Windows and gives the smallest upgrade for each. Runs in your browser.
https://abhishek01239.github.io/product-factory/py315-check/

## Bluesky

Python 3.15 is out, and `python:3` / setup-python '3.x' now install it. Old pins like numpy 2.2.6 or pandas 2.2.3 have no 3.15 wheels, so pip compiles from source and slim images fail.

Free browser-only check: your lockfile in, the smallest upgrade with 3.15 wheels out, plus removed APIs in your code.
https://abhishek01239.github.io/product-factory/py315-check/

## Mastodon

Python 3.15.0 (Oct 9) means new cp315 wheels for every compiled package, and older releases never get them. The Docker python:3/slim/alpine tags and setup-python '3.x' already point to 3.15.

pyreadiness.org tells you whether the latest release of a popular package supports 3.15. I wanted to know whether *my pinned versions* install, so I made a free, browser-only checker: it reads requirements.txt, uv.lock, poetry.lock, Pipfile.lock or a public repo, checks each pin's wheels per platform, suggests the smallest fixing upgrade (and spots parent pins like pydantic → pydantic-core), and scans code for APIs removed in 3.15.

https://abhishek01239.github.io/product-factory/py315-check/

#Python #Python315 #DevOps

## Threads

Python 3.15 came out last week and "3.x" in CI now means 3.15. If a build broke compiling numpy or pandas, your pins are older than their 3.15 wheels.

Free checker that shows which pins and the smallest upgrade for each: https://abhishek01239.github.io/product-factory/py315-check/

## Reddit (r/Python, r/learnpython): only if the subreddit allows tools; post as a how-to

Title: Python 3.15 is out and "3.x" now means 3.15: how to check whether your pinned dependencies will install

Body: If your CI uses `python-version: '3.x'` or a Dockerfile uses `python:3`, `python:slim` or `python:alpine`, it picked up 3.15.0 after Oct 9. The common first failure is a pinned compiled package without a cp315 wheel, so pip builds from source.

Quick manual check for one package:
`pip download --only-binary=:all: --python-version 3.15 --no-deps numpy==2.2.6`
(fails → no wheel for 3.15 on this platform)

Where 3.15 wheels start on PyPI today: numpy 2.5.2, pandas 3.0.6, psycopg2-binary 2.9.13; PyYAML has none yet. If something like pydantic-core is flagged, upgrade its parent (pydantic) because it pins the child exactly.

Code changes worth grepping for: `sre_constants`/`sre_parse`, `CGIHTTPRequestHandler`, `glob.glob1`, `co_lnotab`, `strptime` formats with `%d` but no year, and `sqlite3.connect(db, 10)` (now keyword-only).

I put this into a free browser tool that does it for the whole lockfile across Linux/macOS/Windows: https://abhishek01239.github.io/product-factory/py315-check/ (no sign-in, nothing uploaded; it asks PyPI for public file lists).
