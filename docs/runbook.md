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
7. Local defaults:
   - API listens on `http://localhost:3002`
   - Web uses `NEXT_PUBLIC_API_BASE_URL=http://localhost:3002`
   - If port `3000` is already occupied, Next may move the web app to another port, but it should still point at the API on `3002`.

## Indexing
- One-off indexer run: `pnpm --filter @taikoproofs/api indexer`
- Vercel cron will call `GET /admin/index` every 10 minutes.
- Live indexing is Shasta-only from the fork at `2026-04-02 13:15:00 UTC`.
- If `SHASTA_START_BLOCK` is unset, a fresh database derives the first block at or after `2026-04-02 13:15:00 UTC` automatically.
- Pacaya data is archived in the existing `batches` / `batch_proofs` tables for display and history only.
- Do not point the indexer back at the Pacaya inbox and do not plan fresh Pacaya re-indexes. If historical Pacaya data is ever needed in a new environment, restore it from a database snapshot instead of chain re-indexing.
- Shasta proposals start at proposal id `1`; the activation-time `Proposed(id=0)` event is intentionally ignored.

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

## Proof classification
- Live Shasta proof classification does not rely on a local verifier mapping file.
- The indexer decodes `prove(bytes,bytes)` calldata, reads the inbox `proofVerifier` from `getConfig()`, and classifies verifier ids directly from the Shasta proof payload.

## Troubleshooting
- If Shasta proposals show empty proof systems, verify RPC health and confirm the proof tx input decodes as `prove(bytes,bytes)`.
- If latency metrics are empty, ensure `proposed_at` and `proven_at` are populated in either `batches` or `shasta_proposals`.
