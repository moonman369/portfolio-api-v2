# Stats eval — old pipeline vs new

> **NOT YET RUN.** This file is a placeholder. The harness
> (`scripts/stats-eval.js`) is written and its pure logic is verified, but it has never
> been executed: it needs both services reachable and a live `OPENAI_API_KEY`, and there
> is no `.env` in the working copy this phase was built in.
>
> **Running it overwrites this file entirely** with the real results.

## How to run it

```bash
node --env-file=.env scripts/stats-eval.js \
  --old https://<old-host> \
  --new https://api.portfolio.moonman.in
```

Passwords come from the environment, never a flag: `MOONMIND_PASSWORD` for the new
service and `OLD_MOONMIND_PASSWORD` for the old one (defaults to the same value).
Omit `--old` to record the new pipeline on its own.

Exit code is 0 when every question routed as expected and echoed no unverified number,
1 otherwise.

## What it records

Ground truth comes straight from `/api/v1/github` and `/api/v1/leetcode/:username` on
the new service, so the prose can be checked against the same numbers those endpoints
return. For each question the file will carry the old answer, the new answer, the route
the new pipeline chose, which ground-truth numbers the answer echoed, and any
unverified number over 100 that is not a plausible year.

| # | Question | Expected route |
|---|---|---|
| 1 | How many public repos does Ayan have on GitHub? | `stats` |
| 2 | What is Ayan's LeetCode ranking? | `stats` |
| 3 | How many LeetCode problems has he solved, and how many were hard? | `stats` |
| 4 | Give me his GitHub stats — repos, commits, stars and pull requests. | `stats` |
| 5 | Show me my github stats and my projects | `stats_and_docs` |

Question 5 is the mixed query the old regex router handled and the LLD's taxonomy has
no slot for. Until Phase 3b lands `about_me`, its portfolio half returns nothing and the
answer covers the stats half only — expect the old pipeline to say more here, and expect
that gap to close in 3b rather than in this phase.

## Prerequisites

Both are outstanding at the time of writing:

1. The new service deployed and reachable (Phase 0 open items 1–5).
2. `/api/v1/refresh` run at least once against the new service, or `/api/v1/github`
   returns `null` and the stats node reports GitHub as unavailable — correctly, but it
   makes for a useless comparison.
