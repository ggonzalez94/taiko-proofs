import { Module } from "@nestjs/common";
import { StatsService } from "./stats.service";
import { StatsController } from "./stats.controller";
import { PrismaModule } from "../prisma/prisma.module";
import { AppConfigModule } from "../config/app-config.module";

@Module({
  imports: [PrismaModule, AppConfigModule],
  providers: [StatsService],
  controllers: [StatsController],
  exports: [StatsService]
})
export class StatsModule {}
