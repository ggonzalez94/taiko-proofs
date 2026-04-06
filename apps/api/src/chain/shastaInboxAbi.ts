export const shastaInboxAbi = [
  {
    type: "event",
    name: "Proposed",
    inputs: [
      { indexed: true, name: "id", type: "uint48" },
      { indexed: true, name: "proposer", type: "address" },
      { indexed: false, name: "parentProposalHash", type: "bytes32" },
      {
        indexed: false,
        name: "endOfSubmissionWindowTimestamp",
        type: "uint48"
      },
      { indexed: false, name: "basefeeSharingPctg", type: "uint8" },
      {
        indexed: false,
        name: "sources",
        type: "tuple[]",
        components: [
          { name: "isForcedInclusion", type: "bool" },
          {
            name: "blobSlice",
            type: "tuple",
            components: [
              { name: "blobHashes", type: "bytes32[]" },
              { name: "offset", type: "uint24" },
              { name: "timestamp", type: "uint48" }
            ]
          }
        ]
      }
    ],
    anonymous: false
  },
  {
    type: "event",
    name: "Proved",
    inputs: [
      { indexed: false, name: "firstProposalId", type: "uint48" },
      { indexed: false, name: "firstNewProposalId", type: "uint48" },
      { indexed: false, name: "lastProposalId", type: "uint48" },
      { indexed: true, name: "actualProver", type: "address" }
    ],
    anonymous: false
  },
  {
    type: "function",
    name: "prove",
    inputs: [
      { name: "_data", type: "bytes" },
      { name: "_proof", type: "bytes" }
    ],
    outputs: [],
    stateMutability: "nonpayable"
  },
  {
    type: "function",
    name: "getConfig",
    inputs: [],
    outputs: [
      {
        name: "config_",
        type: "tuple",
        components: [
          { name: "proofVerifier", type: "address" },
          { name: "proposerChecker", type: "address" },
          { name: "proverWhitelist", type: "address" },
          { name: "signalService", type: "address" },
          { name: "bondToken", type: "address" },
          { name: "minBond", type: "uint64" },
          { name: "livenessBond", type: "uint64" },
          { name: "withdrawalDelay", type: "uint48" },
          { name: "provingWindow", type: "uint48" },
          { name: "permissionlessProvingDelay", type: "uint48" },
          { name: "maxProofSubmissionDelay", type: "uint48" },
          { name: "ringBufferSize", type: "uint48" },
          { name: "basefeeSharingPctg", type: "uint8" },
          { name: "forcedInclusionDelay", type: "uint16" },
          { name: "forcedInclusionFeeInGwei", type: "uint64" },
          { name: "forcedInclusionFeeDoubleThreshold", type: "uint64" },
          { name: "permissionlessInclusionMultiplier", type: "uint8" }
        ]
      }
    ],
    stateMutability: "view"
  }
] as const;
