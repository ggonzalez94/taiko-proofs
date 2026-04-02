import { Prisma } from "@prisma/client";

export const combinedProtocolRecordsSql = Prisma.sql`
  SELECT
    'PACAYA'::text AS "protocol",
    CONCAT('pacaya:', batch_id::text) AS "recordKey",
    batch_id::text AS "batchId",
    proposer AS "proposer",
    status::text AS "status",
    proof_systems AS "proofSystems",
    tee_verifiers AS "teeVerifiers",
    proposed_at AS "proposedAt",
    proven_at AS "provenAt",
    verified_at AS "verifiedAt",
    is_contested AS "isContested",
    is_legacy AS "isLegacy"
  FROM batches

  UNION ALL

  SELECT
    'SHASTA'::text AS "protocol",
    CONCAT('shasta:', proposal_id::text) AS "recordKey",
    proposal_id::text AS "batchId",
    proposer AS "proposer",
    status::text AS "status",
    proof_systems AS "proofSystems",
    tee_verifiers AS "teeVerifiers",
    proposed_at AS "proposedAt",
    proven_at AS "provenAt",
    verified_at AS "verifiedAt",
    is_contested AS "isContested",
    FALSE AS "isLegacy"
  FROM shasta_proposals
`;

export const combinedProtocolStatsSql = Prisma.sql`
  SELECT
    proposed_at,
    proven_at,
    verified_at,
    status,
    proof_systems,
    tee_verifiers,
    is_contested
  FROM batches

  UNION ALL

  SELECT
    proposed_at,
    proven_at,
    verified_at,
    status,
    proof_systems,
    tee_verifiers,
    is_contested
  FROM shasta_proposals
`;
