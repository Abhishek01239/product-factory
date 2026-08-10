# Memory — persistent, versioned learning

This directory is the factory's long-term external memory. It is **committed to git**
so every learning change is traceable and rollback-able (see `VERSION`).

```
memory/
  VERSION      # current memory version (int)
  v1/          # snapshot of all knowledge for version 1
    projects/
      successful/*.json     # postmortems of shipped products
      failed/*.json         # postmortems of abandoned products
    lessons/*.json          # structured lessons (problem → cause → solution → rule)
    security/findings.jsonl # security audit findings, one JSON per line
    trends/history.jsonl    # trend items seen over time
```

Rules:

- The Groq model is **never retrained**. All learning lives here.
- `MemoryStore.bump_version()` snapshots the current version to `v+1` before
  new knowledge is written — a regression can be rolled back by restoring
  `VERSION` from git history.
- Before planning a new project, the planner reads the digests of past
  projects and lessons (see `factory/memory/store.py::digest`).

Version 1 is seeded empty. The factory populates it as runs complete.