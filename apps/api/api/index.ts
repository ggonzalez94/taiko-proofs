import "reflect-metadata";
import { NestFactory } from "@nestjs/core";
import { ValidationPipe } from "@nestjs/common";
import { ExpressAdapter } from "@nestjs/platform-express";
import express from "express";
import { AppModule } from "../src/app.module";
import { parseRpcUrls } from "../src/chain/rpc-transport";

const expressApp = express();
let cachedApp: express.Express | null = null;

function hostFromUrl(value: string | undefined): string | null {
  if (!value) {
    return null;
  }

  try {
    return new URL(value).host;
  } catch {
    return "invalid";
  }
}

function logEnvSummary() {
  console.log("[bootstrap] env summary", {
    nodeEnv: process.env.NODE_ENV ?? "unset",
    vercelEnv: process.env.VERCEL_ENV ?? "unset",
    region: process.env.VERCEL_REGION ?? "unset",
    databaseHost: hostFromUrl(process.env.DATABASE_URL),
    rpcHosts: parseRpcUrls(process.env.RPC_URL ?? "").map(hostFromUrl),
    chainId: process.env.CHAIN_ID ?? "unset",
    shastaInboxAddressSet: Boolean(
      process.env.SHASTA_INBOX_ADDRESS ?? process.env.TAIKO_INBOX_ADDRESS
    )
  });
}

async function bootstrap(): Promise<express.Express> {
  const start = Date.now();
  logEnvSummary();
  console.log("[bootstrap] starting Nest app");

  try {
    const app = await NestFactory.create(AppModule, new ExpressAdapter(expressApp), {
      logger: ["error", "warn"]
    });

    app.enableCors();
    app.useGlobalPipes(
      new ValidationPipe({
        transform: true,
        whitelist: true
      })
    );

    console.log("[bootstrap] initializing Nest app");
    await app.init();
    console.log(`[bootstrap] Nest app ready in ${Date.now() - start}ms`);
    return expressApp;
  } catch (error) {
    console.error("[bootstrap] Nest app failed to initialize", error);
    throw error;
  }
}

export default async function handler(req: express.Request, res: express.Response) {
  if (!cachedApp) {
    cachedApp = await bootstrap();
  }

  return cachedApp(req, res);
}
