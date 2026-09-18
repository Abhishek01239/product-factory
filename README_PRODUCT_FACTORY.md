# Product Factory — operating plan

## Mission
Turn evidence-backed recurring problems into small, useful products.

## Current MVP
The Python factory already provides the core offline/CI pipeline:
1. trend discovery from public sources
2. opportunity scoring
3. AI/deterministic planning
4. product generation
5. tests + repair loop
6. security/SEO/accessibility/legal/ads/secrets gates
7. deployment decision
8. distribution
9. postmortem + learning memory

A lightweight dashboard is included in `dashboard/`.

## Operating modes
- `approval_required`: research/build/audit, then wait for human approval before side effects.
- `autonomous`: allows the configured deploy/distribution side effects.

For a first production rollout, keep approval mode enabled until credentials and deployment behavior have been verified.

## Next implementation layer
- expose workflow dispatch as a controlled command endpoint
- persist opportunity/project state in Supabase
- add browser-based verification after deployment
- connect product analytics
- add a human approval queue
- add product lifecycle states: discovered → validated → building → review → live → improving → retired
- add a command interface for requests such as:
  "find problems", "investigate opportunity X", "build X", "test X", "launch X", "improve X"

## Definition of success
The system should optimize for useful shipped products, not number of ideas. Every opportunity needs evidence, a concrete user problem, a smallest useful MVP, and a measurable post-launch signal.
