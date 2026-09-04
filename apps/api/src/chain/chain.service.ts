import { Injectable } from "@nestjs/common";
import { createPublicClient, PublicClient } from "viem";
import { AppConfigService } from "../config/app-config.service";
import { buildEndpointTransport, createRpcTransport } from "./rpc-transport";

@Injectable()
export class ChainService {
  private client: PublicClient;

  constructor(private readonly config: AppConfigService) {
    const timeoutMs = this.config.rpcTimeoutMs;
    const endpoints = this.config.rpcUrls.map((url) => ({
      url,
      transport: buildEndpointTransport(url, timeoutMs)
    }));

    this.client = createPublicClient({
      transport: createRpcTransport(endpoints, { timeoutMs })
    });
  }

  getClient(): PublicClient {
    return this.client;
  }
}
