import { Transform } from "class-transformer";
import { IsBoolean, IsISO8601, IsIn, IsInt, IsOptional, Min } from "class-validator";
import {
  BatchDateField,
  BatchProofType,
  BatchStatus,
  ProofSystem,
  TeeVerifier
} from "@taikoproofs/shared";

const batchStatusValues: BatchStatus[] = ["proposed", "proven", "verified"];
const proofSystemValues: ProofSystem[] = ["TEE", "SP1", "RISC0"];
const teeVerifierValues: TeeVerifier[] = ["SGX_GETH", "TDX_GETH", "SGX_RETH"];
const proofTypeValues: BatchProofType[] = ["all", "zk", "non-zk"];
const dateFieldValues: BatchDateField[] = ["proposedAt", "provenAt"];

const toBoolean = ({ value }: { value: unknown }) => {
  if (value === "true" || value === true) {
    return true;
  }
  if (value === "false" || value === false) {
    return false;
  }
  return value;
};

export class BatchesQueryDto {
  @IsOptional()
  @IsIn(batchStatusValues)
  status?: BatchStatus;

  @IsOptional()
  @Transform(({ value }) =>
    typeof value === "string" ? value.split(",").filter(Boolean) : value
  )
  @IsIn(proofSystemValues, { each: true })
  system?: ProofSystem[];

  @IsOptional()
  @Transform(({ value }) =>
    typeof value === "string" ? value.split(",").filter(Boolean) : value
  )
  @IsIn(teeVerifierValues, { each: true })
  teeVerifier?: TeeVerifier[];

  @IsOptional()
  @IsIn(proofTypeValues)
  proofType?: BatchProofType;

  @IsOptional()
  @Transform(toBoolean)
  @IsBoolean()
  hasProof?: boolean;

  @IsOptional()
  @IsIn(dateFieldValues)
  dateField?: BatchDateField;

  @IsOptional()
  @Transform(toBoolean)
  @IsBoolean()
  contested?: boolean;

  @IsOptional()
  search?: string;

  @IsOptional()
  @IsISO8601()
  start?: string;

  @IsOptional()
  @IsISO8601()
  end?: string;

  @IsOptional()
  @Transform(({ value }) => (value ? Number(value) : undefined))
  @IsInt()
  @Min(1)
  page?: number;

  @IsOptional()
  @Transform(({ value }) => (value ? Number(value) : undefined))
  @IsInt()
  @Min(1)
  pageSize?: number;
}
