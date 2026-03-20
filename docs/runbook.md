# TaikoProofs Runbook

## Local setup
1. Copy envs:
   - `apps/api/.env.example` -> `apps/api/.env`
   - `apps/web/.env.example` -> `apps/web/.env`
2. (Optional) Start Postgres via Docker:
   - `cp .env.example .env`
   - `docker compose up -d`
   - Default port is `5433`, update `DATABASE_URL` if you change it.
3. Ensure Postgres is running and `DATABASE_URL` is correct.
4. Install deps: `pnpm install` from `taikoproofs/`.
5. Run migrations: `pnpm --filter @taikoproofs/api exec prisma migrate deploy`.
6. Start dev servers:
   - API: `pnpm --filter @taikoproofs/api dev`
   - Web: `pnpm --filter @taikoproofs/web dev`

## Indexing
- One-off indexer run: `pnpm --filter @taikoproofs/api indexer`
- Vercel cron will call `GET /admin/index` every 10 minutes.
- Batches verified before `START_BLOCK` are stored as verified-only and may show limited details.

## ZK alert poller
- Standalone script: `scripts/zk_alert.py`
- Local venv on this machine: `source .venv/bin/activate`
- The poller queries `/stats/zk` with a rolling 24 hour window using full ISO timestamps.
- It also alerts when the API itself is unreachable and sends a recovery notification once the API responds again.
- It stores local dedupe state in `/tmp/taikoproofs-zk-alert-state.json` by default.

### Required env vars
- `ZK_ALERT_API_BASE_URL`

### Optional env vars
- `ZK_ALERT_THRESHOLD` default `80`
- `ZK_ALERT_MIN_SAMPLES` default `20`
- `ZK_ALERT_COOLDOWN_SECONDS` default `21600`
- `ZK_ALERT_INTERVAL_SECONDS` default `600`
- `ZK_ALERT_STATE_FILE` default `/tmp/taikoproofs-zk-alert-state.json`
- `ZK_ALERT_TIMEOUT_SECONDS` default `10`
- `ZK_ALERT_SLACK_WEBHOOK_URL`
- `ZK_ALERT_TELEGRAM_BOT_TOKEN`
- `ZK_ALERT_TELEGRAM_CHAT_ID`

### Example
```bash
export ZK_ALERT_API_BASE_URL=https://api.proofs.taiko.xyz
export ZK_ALERT_SLACK_WEBHOOK_URL=https://hooks.slack.com/services/...
python scripts/zk_alert.py
```

### Cron example
```bash
*/10 * * * * . ZK_ALERT_API_BASE_URL=https://api.proofs.taiko.xyz ZK_ALERT_SLACK_WEBHOOK_URL=https://hooks.slack.com/services/... python ./scripts/zk_alert.py >> /tmp/taikoproofs-zk-alert.log 2>&1
```

### Foreground daemon example
```bash
export ZK_ALERT_API_BASE_URL=https://api.proofs.taiko.xyz
export ZK_ALERT_SLACK_WEBHOOK_URL=https://hooks.slack.com/services/...
python scripts/zk_alert.py --daemon --interval-seconds 600
```

### Alert behavior
- `ZK ratio alert` fires when the rolling 24 hour ratio drops below the configured threshold.
- `ZK ratio recovered` fires when the ratio returns to normal after a breach.
- `API down` fires when `/stats/zk` cannot be reached or parsed successfully.
- `API recovered` fires when the API responds again after a down state.
- The state file keeps `ratio` and `api` dedupe state separately so the two alert classes do not suppress each other.

## Vercel setup
- Two projects with explicit roots:
  - Web root: `apps/web`
  - API root: `apps/api` (keeps `vercel.json` + `api/` at project root)
- Web build command: `pnpm --filter @taikoproofs/web build`
- API build command: `pnpm --filter @taikoproofs/shared build && pnpm --filter @taikoproofs/api build`
- Run Prisma migrations outside Vercel builds (e.g. `db-migrate` workflow or `pnpm --filter @taikoproofs/api exec prisma migrate deploy`).
- Production domains:
  - Web: `proofs.taiko.xyz`
  - API: `api.proofs.taiko.xyz`
- DNS (GoDaddy / non-Vercel nameservers):
  - Set `A proofs.taiko.xyz 76.76.21.21`
  - Set `A api.proofs.taiko.xyz 76.76.21.21`
- Note: We have SSO protection enabled for `*.vercel.app`, so custom domains are the intended public entrypoints.

### GitHub Actions deploy (optional)
- Preview + production deploy workflows:
  - `.github/workflows/vercel--preview.yml`
  - `.github/workflows/vercel--production.yml`
  - Uses `.github/workflows/repo--vercel-deploy.yml` (Vercel CLI `build` + `deploy --prebuilt`).
- Required GitHub repo secrets:
  - `VERCEL_TOKEN`
  - `VERCEL_ORG_ID`
  - `VERCEL_PROJECT_ID_TAIKOPROOFS`
  - `VERCEL_PROJECT_ID_TAIKOPROOFS_API`
- For Prisma migrations via `.github/workflows/db-migrate.yml`, set GitHub Environment `Production – taiko-proofs-api` secrets:
  - `DATABASE_URL`
  - `DIRECT_URL`

## Verifier mapping
- Update verifier mapping via JSON file and set `VERIFIER_CONFIG_PATH`.
- Format:
  ```json
  {"tee": ["0x..."], "sp1": ["0x..."], "risc0": ["0x..."]}
  ```

## Troubleshooting
- If batches show empty proof systems, verify the address mapping and RPC health.
- If latency metrics are empty, ensure `proposed_at` and `proven_at` are populated.
