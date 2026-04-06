# Taiko Event Architecture After Shasta

This repository now treats Taiko mainnet as two eras:

- **Pacaya archive**: historical-only data already stored in `batches` and `batch_proofs`
- **Shasta live**: active indexing source from `2026-04-02 13:15:00 UTC`

Pacaya is kept for display and historical queries only. The live indexer must not read the Pacaya inbox again.

## Inbox Addresses

- Pacaya inbox: `0x06a9Ab27c7e2255df1815E6CC0168d7755Feb19a`
- Shasta inbox: `0x6f21C543a4aF5189eBdb0723827577e1EF57ef1f`

## Read Model

- Pacaya rows remain in:
  - `batches`
  - `batch_proofs`
- Shasta rows are written to:
  - `shasta_proposals`
- API reads merge both eras with an explicit `protocol` marker and `recordKey` (`pacaya:123`, `shasta:123`).

## Pacaya Archive Rules

- No new Pacaya proposals exist after the fork timestamp.
- Pacaya ids remain meaningful only inside the archived dataset.
- Do not re-index Pacaya from chain logs for new environments. Restore archived data from a database snapshot instead.

## Shasta Live Events

Authoritative contracts:

- `packages/protocol/contracts/layer1/core/iface/IInbox.sol`
- `packages/protocol/contracts/layer1/core/impl/Inbox.sol`
- `packages/protocol/contracts/layer1/mainnet/MainnetInbox.sol`
- `packages/protocol/contracts/layer1/mainnet/MainnetVerifier.sol`

Events to monitor from the Shasta inbox:

1. `Proposed(uint48 id, address proposer, bytes32 parentProposalHash, ...)`
2. `Proved(uint48 firstProposalId, uint48 firstNewProposalId, uint48 lastProposalId, address actualProver)`

Important behavior changes:

- Proposal ids restart at `1` on Shasta.
- The activation flow emits `Proposed(id=0)` for genesis state; ignore it.
- `prove(bytes,bytes)` finalizes proposals immediately.
- There is no separate `Verified` event path like Pacaya.

## Shasta Proposal Handling

Extract from `Proposed`:

- `id`
- `proposer`
- `parentProposalHash`
- L1 `blockNumber` as `proposed_block`
- L1 block timestamp as `proposed_at`
- `transactionHash` as `proposed_tx_hash`

Indexing rule:

- Upsert `shasta_proposals` by `proposal_id`
- Ignore `proposal_id = 0`

## Shasta Proof Handling

`prove(bytes _data, bytes _proof)` carries two distinct payloads:

- `_data`: compact-packed `ProveInput`
- `_proof`: ABI-encoded `ComposeVerifier.SubProof[]`

### Packed `_data`

The packed commitment contains:

- `firstProposalId`
- `firstProposalParentBlockHash`
- `lastProposalHash`
- `actualProver`
- `endBlockNumber`
- `endStateRoot`
- `Transition[] transitions`

Each transition contains:

- `proposer`
- `timestamp`
- `blockHash`

### `_proof` decoding

`_proof` decodes as:

```text
SubProof[] {
  uint8 verifierId
  bytes proof
}
```

On Shasta mainnet, verifier ids map to proof systems as follows:

- `1` = `SGX_GETH` -> `TEE`
- `2` = `TDX_GETH` -> `TEE`
- `4` = `SGX_RETH` -> `TEE`
- `5` = `RISC0_RETH` -> `RISC0`
- `6` = `SP1_RETH` -> `SP1`

The live indexer also resolves the inbox `proofVerifier` from `getConfig()` and stores that address as the top-level verifier address for Shasta rows.

### Finalization rule

For every proposal in the newly finalized range `firstNewProposalId..lastProposalId`:

- set `proven_at` and `verified_at` from the proof tx block timestamp
- set `proven_block` and `verified_block` from the proof tx block number
- set `proof_tx_hash` and `verified_tx_hash` to the same proof tx hash
- set `status = verified`
- compute `transition_parent_hash` from either:
  - `firstProposalParentBlockHash` for the first transition in range
  - previous transition `blockHash` for later transitions

## Reorg Strategy

- Rewind `reorgBuffer` blocks on every run.
- For `shasta_proposals` with `proven_block` inside the rewind window:
  - clear proof/finalization fields and return them to `status = proposed`
- For `shasta_proposals` with `proposed_block` inside the rewind window:
  - delete the row entirely

## Stats

Charts and summaries now aggregate over a unified SQL read layer:

- Pacaya archive rows from `batches`
- Shasta live rows from `shasta_proposals`

This preserves historical continuity while keeping Pacaya indexing permanently disabled.
