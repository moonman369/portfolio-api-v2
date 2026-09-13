# about_me eval — old pipeline vs new

> **NOT YET RUN.** This file is a placeholder. `scripts/about-me-eval.js` is written and
> the node is covered by offline tests, but the eval has never been executed: it needs
> both services reachable, plus live OpenAI, Gemini and Atlas credentials.
>
> **Running it overwrites this file entirely** with the real results. Phase 3b is not
> finished until you have read those results and agreed the quality is equivalent —
> that judgement is explicitly yours, not the script's.

## How to run it

```bash
node --env-file=.env scripts/about-me-eval.js \
  --old https://<old-host> \
  --new https://api.portfolio.moonman.in
```

Passwords come from the environment, never a flag: `MOONMIND_PASSWORD` for the new
service and `OLD_MOONMIND_PASSWORD` for the old one (defaults to the same value).
Omit `--old` to record the new pipeline alone.

Exit code is 0 when every question routed as expected and retrieved an overlapping set
of documents, 1 otherwise.

## What it records

For each question: the full answer from both pipelines, the route the new one chose, and
the overlap between the document ids each retrieved (shared, only-old, only-new, and a
Jaccard score).

**Retrieved-id overlap is the objective signal.** Two answers can be worded quite
differently and still be grounded in exactly the same documents — that is what
"equivalent quality" means here. Low overlap is the thing worth investigating; different
prose on identical sources usually is not.

| # | Question | Expected route |
|---|---|---|
| 1 | What backend technologies does Ayan work with? | `about_me` |
| 2 | Tell me about Ayan's experience at Tata Consultancy Services. | `about_me` |
| 3 | What certifications does he hold? | `about_me` |
| 4 | What projects has he built involving RAG or vector search? | `about_me` |
| 5 | What is his educational background? | `about_me` |
| 6 | What are his hobbies and interests outside work? | `about_me` |
| 7 | How has he used generative AI in his day-to-day engineering work? | `about_me` |
| 8 | What are his strongest skills, and which projects demonstrate them? | `about_me` |
| 9 | Has Ayan ever worked on underwater basket weaving? | `about_me` |
| 10 | Show me my github stats and my projects | `stats_and_docs` |

Question 8 is multi-part, so it exercises decomposition when
`MOONMIND_DECOMPOSE_ENABLED` is on. Question 9 should match nothing — the answer must
stay helpful and say so rather than returning a bare refusal, which is a rule carried
over from the old response prompt. Question 10 is the mixed query; unlike in Phase 2 it
should now return both stats and documents, since `about_me` is no longer a stub.

## Prerequisites

1. The new service deployed and reachable (Phase 0 open items).
2. `/api/v1/refresh` run at least once, or question 10's stats half reports GitHub as
   unavailable.
3. The vector collection populated and its Atlas index live — the new pipeline reads the
   same `moonmind_documents_v3` as the old one, so no migration is needed.

## Things to look at when reading the output

- **Question 9** — does the new answer stay helpful, or does it degrade into a refusal?
- **Question 10** — are both halves present, stats *and* portfolio?
- **Any question with zero overlap** — check whether the old pipeline retrieved anything
  at all before assuming the new one is at fault.
- **Numbers in the prose** — nothing outside the retrieved documents should appear.
