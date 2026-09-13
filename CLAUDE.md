# CLAUDE.md — standing rules

Short by design. The detail lives in `docs/`.

## Project

A **clean rewrite** of Portfolio-Stats-API's service plus a **LangChain + LangGraph
agentic rebuild** of its MoonMind chat pipeline. Leaner and better organized than the old
repo — not a copy of its structure.

- `docs/reference/moonmind_agentic_lld.md` — **the plan**. Companion:
  `moonmind_langchain_feasibility.md`.
- `docs/ARCHITECTURE.md` — **the shape**. Layout, dependency rules, graph design.
- `docs/DATA_MODEL.md` — **the data contract**. Reconciled against the real validator.
- `docs/OLD_REPO_MAP.md` — what the old service does, and the Leave-behind list.
- `docs/PROGRESS.md` — phase state, handoff log, decisions, deviations.

**If code or a prompt conflicts with these, stop and ask.** Don't silently reconcile.

## Stack

Node 22, CommonJS, Express, the official MongoDB driver, zod.
**LangChain + LangGraph together as one stack** — LangGraph is LangChain's orchestration
layer, not a separate framework to adopt later. Never propose dropping or deferring it.

Lean by default: native `fetch` + `AbortSignal.timeout` (no axios), `node --env-file=.env`
(no dotenv), `node:test` (no jest). Justify every new dependency in PROGRESS.md.

## Config

- `src/config.js` is the **only** reader of `process.env` — zod-validated at boot, frozen,
  fails fast. Everything else imports `config`.
- Prefixes: `MONGO_`, `GEMINI_`, `MOONMIND_`.
- Per-role model vars stay independent: `MOONMIND_ROUTER_MODEL`, `MOONMIND_INTENT_MODEL`,
  `MOONMIND_RESPONSE_MODEL`, `MOONMIND_RERANK_MODEL` → falls back to RESPONSE,
  `MOONMIND_DECOMPOSE_MODEL` → falls back to INTENT. Default `gpt-4o-mini`.
- **Never commit secrets.** `.env.example` carries names and shapes only.

## Guardrails

- **Tool isolation is by `TOOLSETS` binding, never by prompting.** What an agent can do is
  what was passed to it.
- **The email recipient is fixed by config** and is never a tool argument — `send_email`
  has no recipient field in its schema.
- **Calendar writes need a code-enforced confirmation** recorded in state on a prior turn.
  The tool refuses without it.
- Every outbound call has a timeout; retries live only in that outbound layer.
- Every node is wrapped by the error boundary — the API never 500s because a node threw.

## Deploy

Docker on an Oracle Cloud Ubuntu VM behind Nginx, `restart: unless-stopped`, GitHub
Actions build → GHCR → VM pull. **Always-on, not serverless** — no function timeouts to
design around.

**Never hardcode VM paths.** The old API uses `~/api-deploy`; this one gets its own folder,
container name, host port and subdomain — confirm all four with Ayan.

## Working style

- **One phase per session.** Additive commits.
- **Stop at ⛔ GATEs** and at any unclear design point. Ask; don't guess.
- **The old repo is read-only.** `../Portfolio-Stats-API-ref`
  (github.com/moonman369/Portfolio-Stats-API, branch `master`). Never modify it, never
  commit into it.
- Rewrite, don't copy. The only near-verbatim carry-overs are the embedding templates +
  truncation, RRF, and the ranker scoring (see ARCHITECTURE.md §3).

## End-of-phase checklist

1. `node --test` passes.
2. **Structure check** — new files match the ARCHITECTURE.md layout and dependency rules;
   no new top-level folders, no grab-bag modules. Any deviation needs a gate.
3. `.env.example` updated.
4. No unused dependencies.
5. Handoff entry in `docs/PROGRESS.md`: shipped, files, env vars, deviations, open items.
6. Commit `phase-N: …`.
7. **Stop.**
