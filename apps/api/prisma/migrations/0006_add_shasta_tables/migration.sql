CREATE TABLE "shasta_proposals" (
  "proposal_id" BIGINT PRIMARY KEY,
  "proposed_at" TIMESTAMPTZ NOT NULL,
  "proposed_block" BIGINT NOT NULL,
  "proposed_tx_hash" VARCHAR(66),
  "proposer" VARCHAR(42) NOT NULL,
  "actual_prover" VARCHAR(42),
  "parent_proposal_hash" VARCHAR(66),
  "proven_at" TIMESTAMPTZ,
  "proven_block" BIGINT,
  "proof_tx_hash" VARCHAR(66),
  "verifier_address" VARCHAR(42),
  "proof_systems" "ProofSystem"[] NOT NULL DEFAULT '{}',
  "tee_verifiers" TEXT[] NOT NULL DEFAULT '{}',
  "verified_at" TIMESTAMPTZ,
  "verified_block" BIGINT,
  "verified_tx_hash" VARCHAR(66),
  "status" "BatchStatus" NOT NULL DEFAULT 'proposed',
  "transition_parent_hash" VARCHAR(66),
  "transition_block_hash" VARCHAR(66),
  "transition_state_root" VARCHAR(66),
  "is_contested" BOOLEAN NOT NULL DEFAULT FALSE,
  "created_at" TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  "updated_at" TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE "shasta_indexing_state" (
  "chain_id" INTEGER PRIMARY KEY,
  "last_processed_block" BIGINT NOT NULL,
  "lock_id" UUID,
  "lock_expires_at" TIMESTAMPTZ,
  "last_run_started_at" TIMESTAMPTZ,
  "last_run_finished_at" TIMESTAMPTZ,
  "last_run_status" TEXT,
  "last_run_error" TEXT,
  "updated_at" TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX "shasta_proposals_proposed_at_idx" ON "shasta_proposals"("proposed_at");
CREATE INDEX "shasta_proposals_proven_at_idx" ON "shasta_proposals"("proven_at");
CREATE INDEX "shasta_proposals_verified_at_idx" ON "shasta_proposals"("verified_at");
CREATE INDEX "shasta_proposals_proven_block_idx" ON "shasta_proposals"("proven_block");
CREATE INDEX "shasta_proposals_verified_block_idx" ON "shasta_proposals"("verified_block");
CREATE INDEX "shasta_proposals_proof_systems_idx" ON "shasta_proposals" USING GIN("proof_systems");
CREATE INDEX "shasta_proposals_tee_verifiers_idx" ON "shasta_proposals" USING GIN("tee_verifiers");
