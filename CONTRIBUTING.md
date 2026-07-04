# Contributing — rallytasks/projections

Process for the **Thrift Store Projection** web app (server-authoritative decision-and-funding tool for first-store nonprofits). This file is intentionally thin — it holds only the few project conventions not covered elsewhere.

**Where everything lives:**

- **Global engineering rules** (branching/CI/deploy `GIT`, `TDD`, `VERIFY`, `PLAN`, `SECRETS`, `DB`, `SERVER`, …): https://github.com/rallytasks/agents/blob/main/AGENTS.md — every rule there applies, cited by ID.
- **Project rules, overrides, the build loop, model policy, regression registry, fixtures, milestone gate map:** [AGENTS.md](./AGENTS.md) (`CLAUDE.md` is a symlink to it).
- **The done bar / golden gate / Mutation Safety Quad / Failure Mode Registry:** [DEFINITION_OF_DONE.md](./DEFINITION_OF_DONE.md).
- **Layer contracts:** [ENGINE_CONTRACT.md](./ENGINE_CONTRACT.md) (math), [DATA_MODEL.md](./DATA_MODEL.md) (schema), [API_SPEC.md](./API_SPEC.md) (endpoints), [SECURITY.md](./SECURITY.md) (auth/secrets), [OPS_RUNBOOK.md](./OPS_RUNBOOK.md) (deploy/restore), [ARCHITECTURE.md](./ARCHITECTURE.md) (system shape). The authoritative requirement is [reference/PRD.md](./reference/PRD.md); the golden tests are the authoritative behavior.

## Project conventions

- **Branch naming:** `<milestone>/<short-slug>` (e.g. `m1/monthly-cashflow`, `m4/override-dag`); bugfixes `fix/<slug>`; docs-only `docs/<slug>`. Branching, protected `main`, "no merge with a red gate," and "docs-only `.md` may go direct to `main`" all per global `GIT`.
- **One milestone per worktree** (`superpowers:using-git-worktrees`) so parallel sprints don't share state.
- **Commit footer:**
  ```
  Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>
  ```
- **PR body:** what changed · which milestone · which PRD sections · review lenses run · the **verification evidence** (paste the Commands proof set from AGENTS.md — `VERIFY`). End with:
  ```
  🤖 Generated with [Claude Code](https://claude.com/claude-code)
  ```
- Never paste secrets, tokens, `view_slug`s, or real financial data into commits, PRs, or logs (`SECRETS`).

## Run the gates locally

```bash
pytest -q                          # unit + integration, zero failures
pytest engine/tests/golden -q      # engine golden + 3-way reconcile (compute == computed_json == LibreOffice recalc)
python recalc.py path/to/x.xlsx    # expect {"status":"success","total_errors":0}; an {"error":...} dict is NOT a pass
npm test -- --run && npm run typecheck   # no web lint gate — eslint was never configured (#374)
```

> `pyproject.toml` sets `addopts = "-q"`, so bare `pytest` prints no per-test summary — pass `-ra` (or `-v`) when you need pasteable proof output.

The golden/recalc gate needs **LibreOffice (`soffice`) pinned to the build-image version** plus `timeout`/`gtimeout` on PATH (`recalc.py` shells out to a headless `soffice` macro). Assert `status == "success"` AND `total_errors == 0` and **fail closed**. Full proof table and tiers: [DEFINITION_OF_DONE.md](./DEFINITION_OF_DONE.md).
