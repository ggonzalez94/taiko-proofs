import { BadRequestException, Controller, Get, Param, Query } from "@nestjs/common";
import { BatchesService } from "./batches.service";
import { BatchesQueryDto } from "./batches.dto";
import { BatchProtocol } from "@taikoproofs/shared";

@Controller("batches")
export class BatchesController {
  constructor(private readonly batches: BatchesService) {}

  @Get()
  async list(@Query() query: BatchesQueryDto) {
    return this.batches.listBatches(query);
  }

  @Get(":protocol/:batchId")
  async getBatchByProtocol(
    @Param("protocol") protocol: string,
    @Param("batchId") batchId: string
  ) {
    if (!/^[0-9]+$/.test(batchId)) {
      throw new BadRequestException("batchId must be a number");
    }

    const normalized = protocol.toUpperCase();
    if (normalized !== "PACAYA" && normalized !== "SHASTA") {
      throw new BadRequestException("protocol must be pacaya or shasta");
    }

    return this.batches.getBatch(normalized as BatchProtocol, batchId);
  }

  @Get(":batchId")
  async getBatch(@Param("batchId") batchId: string) {
    if (!/^[0-9]+$/.test(batchId)) {
      throw new BadRequestException("batchId must be a number");
    }

    return this.batches.getLegacyBatch(batchId);
  }
}
