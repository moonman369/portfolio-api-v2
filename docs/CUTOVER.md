# CUTOVER — moving the portfolio frontend onto portfolio-api-v2

**Stub.** Phase 11 writes the rest of this file: the exact frontend change, the rollback
plan, the monitoring checklist and the agreed zero-traffic period before the old MoonMind
pipeline is decommissioned (see `docs/PROGRESS.md`, Phase 11). Only the section below
exists so far.

---

## Mail is paused — what the backend flag cannot stop (Phase 10.1, 2026-10-06)

`MOONMIND_MAIL_ENABLED` (default `false`, in `src/config.js`) controls **this backend
only**. Off, the API has no mail route, documents no mail field, offers no mail, and
answers a mail request with a booking reply. It cannot reach into the frontend.

- **If the portfolio frontend has its own Web3Forms form or access key, it can still send
  mail directly**, whatever this repo does. Web3Forms delivers anything POSTed with a
  valid key to the inbox bound to that key.
- **To make mail truly unavailable — manual steps for Ayan, outside this repo:**
  1. Remove any Web3Forms form, and any copy of the access key, from the frontend repo.
  2. Rotate or delete the access key in the Web3Forms dashboard, so any copy still in the
     wild (an old deploy, a cached bundle, a fork) stops working.
- When mail resumes: issue a new key, set `WEB3FORMS_ACCESS_KEY` and
  `MOONMIND_MAIL_ENABLED=true` on the VM (boot fails fast if the flag is on without the
  key), and restore the browser-send brief from `docs/FRONTEND_INTEGRATION.md` §11 at
  commit `005e617`.
