import { Module } from "@nestjs/common";
import { IndexerService } from "./indexer.service";
import { IndexerController } from "./indexer.controller";
import { PrismaModule } from "../prisma/prisma.module";
import { ChainModule } from "../chain/chain.module";
import { AppConfigModule } from "../config/app-config.module";
import { StatsModule } from "../stats/stats.module";
import { ShastaProofClassifierService } from "./shasta-proof-classifier.service";

@Module({
  imports: [PrismaModule, ChainModule, AppConfigModule, StatsModule],
  providers: [IndexerService, ShastaProofClassifierService],
  controllers: [IndexerController]
})
export class IndexerModule {}
