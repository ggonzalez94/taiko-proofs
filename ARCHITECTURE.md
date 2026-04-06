# TaikoProofs Architecture

## Goals
- Provide a fast, public dashboard for Taiko batch/proposal proving coverage and latency.
- Keep the system simple, deployable on Vercel, and maintainable.
- Avoid real-time streaming in MVP, but keep the data pipeline extensible.

## High-Level Architecture
- **Frontend**: Next.js app for the dashboard UI.
- **Backend**: NestJS API for stats + batch data and the indexing job trigger.
- **Database**: PostgreSQL for batch records, proofs, and precomputed stats.

## Constraints (Vercel)
- No long-running background workers; indexing runs via Vercel Cron or CLI.
- Serverless function timeouts require chunked indexing.

### Data Flow
1. **Indexer job** (triggered by Vercel Cron or local CLI) reads Shasta inbox events via L1 JSON-RPC.
2. Shasta events are decoded into live proposal records while archived Pacaya rows remain read-only.
3. Daily stats are recomputed for affected ranges.
4. **API** serves unified stats and protocol-aware batch/proposal data to the Next.js frontend.

## Blockchain Access / Indexing Services
- Uses standard **Ethereum JSON-RPC**.
- Recommended providers: **Alchemy**, **Infura**, or **QuickNode**.
- The client is `viem` (typed, EIP-1193 compatible).

## Components

### Frontend (Next.js)
- Single-page dashboard with two tabs: **Stats** and **Batches**.
- API polling every 30-60s for fresh data.
- Charts via `recharts`, minimal but engaging dark UI.

### Backend (NestJS)
- REST endpoints for stats and batches.
- Unified read layer across:
  - archived Pacaya rows in `batches` / `batch_proofs`
  - live Shasta rows in `shasta_proposals`
- Indexer service to ingest Shasta events only:
  - `Proposed`
  - `Proved`
- Proof system classification via decoded Shasta `prove(bytes,bytes)` input and verifier ids.

### Database (PostgreSQL)
Tables:
- **batches**: archived Pacaya canonical batch state
- **batch_proofs**: archived Pacaya proof attempts
- **shasta_proposals**: live Shasta proposal state
- **daily_stats**: precomputed per-day aggregates
- **indexing_state**: legacy Pacaya cursor state
- **shasta_indexing_state**: live Shasta cursor state

Indexes:
- `batches(batch_id)` (PK), plus indexes on `proven_at`, `verified_at`
- `batch_proofs(batch_id)`, `batch_proofs(proven_at)`
- `daily_stats(date)`

## Data Model (MVP)

### batches
- `batch_id` (uint64, PK)
- `proposed_at` (timestamp)
- `proposed_block` (uint64)
- `proposer` (address)
- `proven_at` (timestamp, nullable)
- `proven_block` (uint64, nullable)
- `proof_tx_hash` (hash, nullable)
- `verifier_address` (address, nullable)
- `proof_systems` (enum[]: TEE, SP1, RISC0)
- `verified_at` (timestamp, nullable)
- `verified_block` (uint64, nullable)
- `status` (proposed | proven | verified)
- `transition_parent_hash`, `transition_block_hash`, `transition_state_root` (nullable)
- `is_contested` (bool)

### batch_proofs
- `id` (uuid, PK)
- `batch_id` (uint64, FK)
- `verifier_address` (address)
- `proof_systems` (enum[])
- `proof_tx_hash` (hash)
- `proven_at` (timestamp)
- `proven_block` (uint64)
- `transition_parent_hash`, `transition_block_hash`, `transition_state_root`
- `is_verified` (bool)

### daily_stats
- `date` (date, PK)
- `proven_total`
- `zk_proven_total`
- `tee_total`
- `sp1_total`
- `risc0_total`
- `proving_avg_seconds`
- `verification_avg_seconds`

Notes:
- All dates are bucketed in **UTC**.

### indexing_state
- `chain_id` (int, PK)
- `last_processed_block` (uint64)
- `updated_at`

## Proof System Classification
- Pacaya archive keeps its historical proof-system data.
- Shasta classification decodes `prove(bytes _data, bytes _proof)`:
  - `_data` is the packed `ProveInput` commitment
  - `_proof` decodes to `ComposeVerifier.SubProof[]`
  - verifier ids map to `TEE`, `SP1`, and `RISC0`
- The live indexer resolves the inbox `proofVerifier` through `getConfig()` and stores it as the top-level verifier address for Shasta records.

## Indexing Strategy
- Poll L1 logs with a confirmation buffer (default 6).
- Reprocess a small `reorgBuffer` of blocks each run.
- Pacaya is not re-indexed after the Shasta fork at `2026-04-02 13:15:00 UTC`.
- Shasta rows are upserted idempotently by `proposal_id`.
- Shasta `Proved` finalizes immediately, so `proven_at` and `verified_at` are written from the same transaction.
- Recompute daily stats for the last N days (configurable).

Chunking:
- Each index run processes `fromBlock..toBlock` in chunks (e.g., 2k-5k blocks).
- Vercel cron calls the API endpoint every 10 minutes to keep data fresh.

## API Surface
- `GET /stats/zk?start&end`
- `GET /stats/proof-systems?start&end`
- `GET /stats/latency?type=proving|verification&start&end&verifiedOnly`
- `GET /batches?status&system&search&start&end&page&pageSize`
- `GET /batches/:protocol/:batchId`
- `GET /batches/:batchId`
- `POST /admin/index` (cron trigger)
- `GET /admin/index` (cron trigger)

Responses are JSON and include `range` metadata plus arrays for chart series.

## Frontend UX Notes
- Dark, clean dashboard inspired by ethproofs.
- Clear filtering, minimal chrome.
- Staggered reveal animations for charts and cards.

## Folder Structure
```
taikoproofs/
  apps/
    web/               # Next.js frontend
    api/               # NestJS backend (serverless-ready)
    api/prisma/        # Prisma schema and migrations
  packages/
    shared/            # DTOs and shared types
  scripts/             # Local tooling (seed/indexer)
  docs/
    runbook.md
```

## Deployment (Vercel)
- Two Vercel projects (monorepo):
  - `apps/web` (Next.js)
  - `apps/api` (NestJS serverless)
- Vercel Cron hits `POST /admin/index` on the API.
- Environment variables set in Vercel for DB + RPC + contract address.

## Environment Variables
Backend (`apps/api`):
- `DATABASE_URL`
- `RPC_URL`
- `CHAIN_ID`
- `SHASTA_INBOX_ADDRESS`
- `SHASTA_START_BLOCK`
- `CONFIRMATIONS` (default 6)
- `REORG_BUFFER` (default 100)
- `STATS_LOOKBACK_DAYS` (default 90)
- `L1_EXPLORER_BASE_URL`

Frontend (`apps/web`):
- `NEXT_PUBLIC_API_BASE_URL`
- `NEXT_PUBLIC_L1_EXPLORER_BASE_URL`

## Open Questions / Config
- Network(s) to index: mainnet first (others supported via `CHAIN_ID` + contract address).
- Verifier address mapping ownership: config file + env overrides.
- ZK share time bucket: by proven time (recommended).
