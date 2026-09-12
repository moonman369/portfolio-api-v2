# portfolio-api-v2

Portfolio stats API plus the MoonMind agentic rebuild (LangChain + LangGraph).
A clean rewrite of [Portfolio-Stats-API](https://github.com/moonman369/Portfolio-Stats-API).

Start with [`CLAUDE.md`](CLAUDE.md), then:

| Document | What it is |
|---|---|
| [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) | The shape: layout, dependency rules, graph design |
| [`docs/DATA_MODEL.md`](docs/DATA_MODEL.md) | The data contract for `moonmind_documents_v3` |
| [`docs/OLD_REPO_MAP.md`](docs/OLD_REPO_MAP.md) | What the old service does, and the Leave-behind list |
| [`docs/PROGRESS.md`](docs/PROGRESS.md) | Phase state, handoff log, decisions, deviations |

## Running locally

Requires Node 22+.

```bash
npm install
cp .env.example .env      # then fill in the REQUIRED values
npm run dev               # node --env-file=.env --watch src/server.js
npm test                  # node --test, no network and no API keys needed
```

`npm start` runs without `--env-file` — in production the environment comes from the
container, so there is no `.env` file to read.

## Endpoints

| Method | Path | Auth |
|---|---|---|
| GET | `/health` | none |
| GET | `/` | none |
| GET | `/api/v1/github` | none |
| GET | `/api/v1/leetcode/:username` | none |
| GET | `/api/v1/refresh?secret=…` | `secret` query parameter, rate limited |

`/github` reads a cached document; `/refresh` is what recomputes it from the GitHub API.

## Parity against the old service

```bash
node scripts/parity-check.js --old https://<old-host> --new https://<new-host>
# add --include-refresh (needs REFRESH_SECRET in the environment) to compare /refresh,
# which mutates the stats document on both services
```

## Deploy

An always-on Docker container on the Oracle Cloud VM behind Nginx. GitHub Actions runs
the tests, builds the image, pushes it to GHCR and SSHes in to pull it.

| Setting | Value |
|---|---|
| Image | `ghcr.io/moonman369/portfolio-api-v2:latest` |
| Container | `portfolio-api-v2` |
| VM folder | `portfolio-api-v2` (relative to the deploy user's home) |
| Host port | `127.0.0.1:8001` → container `8000` |
| Subdomain | `api.portfolio.moonman.in` |

None of these collide with the old API (`~/api-deploy`, `portfolio-stats-api`, port
`8000`).

### One-time VM setup

```bash
mkdir -p ~/portfolio-api-v2 && cd ~/portfolio-api-v2
# copy docker-compose.yml from this repo, then create .env from .env.example
```

### GitHub repository secrets

`VM_HOST`, `VM_USER`, `VM_SSH_KEY`, and `VM_APP_DIR` (set it to `portfolio-api-v2`).
The workflow fails loudly if `VM_APP_DIR` is unset rather than guessing a path.

### Nginx

Add a server block for `api.portfolio.moonman.in` proxying to `http://127.0.0.1:8001`,
then issue a certificate with Certbot. The app sets `trust proxy 1`, so the proxy must
forward `X-Forwarded-For` and `X-Forwarded-Proto` for rate limiting to key on the real
client IP.
