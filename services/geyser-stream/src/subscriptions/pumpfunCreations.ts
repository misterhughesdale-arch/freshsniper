import { EventEmitter } from "events";
import YellowstoneClient, {
  CommitmentLevel,
  type SubscribeRequest,
  type SubscribeRequestFilterTransactions,
  type SubscribeUpdate,
  type YellowstoneStream,
} from "@triton-one/yellowstone-grpc";
import type { FreshSniperConfig } from "@fresh-sniper/config";
import type { Logger } from "@fresh-sniper/logging";
import type { MetricsClient } from "@fresh-sniper/metrics";

interface SubscribeDeps {
  config: FreshSniperConfig;
  logger: Logger;
  metrics: MetricsClient;
  eventBus: EventEmitter;
  clientFactory?: (endpoint: string, token?: string) => YellowstoneClient;
}

export interface GeyserSubscription {
  close: () => void;
}

interface MintedTokenInfo {
  mint: string;
  owner: string;
  programId: string;
  amountRaw: string;
  amountUi?: number;
  amountUiString?: string;
}

export async function subscribePumpfunCreations({
  config,
  logger,
  metrics,
  eventBus,
  clientFactory = createYellowstoneClient,
}: SubscribeDeps): Promise<GeyserSubscription> {
  const client = clientFactory(config.geyser.endpoint, config.geyser.auth_token);
  const request = buildSubscribeRequest(config);
  const reconnectConfig = {
    initial: config.geyser.reconnect.initial_backoff_ms,
    max: config.geyser.reconnect.max_backoff_ms,
  };

  let stream: YellowstoneStream | null = null;
  let reconnectDelay = reconnectConfig.initial;
  let reconnectTimer: number | null = null;
  let isClosed = false;

  const connect = async () => {
    if (isClosed) return;

    try {
      logger.info({ endpoint: config.geyser.endpoint }, "connecting to shyft geyser stream");
      const nextStream = await client.subscribe();
      stream = nextStream;
      reconnectDelay = reconnectConfig.initial;
      logger.info({}, "shyft geyser stream connected");

      stream.on("data", (update: SubscribeUpdate) => {
        const startedAt = Date.now();
        try {
          processUpdate(update, { config, logger, metrics, eventBus });
        } catch (error) {
          logger.error({ err: serializeError(error) }, "failed to process geyser update");
          metrics.incrementCounter("geyser_stream_processing_errors");
        } finally {
          metrics.observeLatency("pumpfun_geyser_process_ms", Date.now() - startedAt);
        }
      });

      stream.on("error", (error: unknown) => {
        if (isClosed) return;
        logger.error({ err: serializeError(error) }, "geyser stream error");
        metrics.incrementCounter("geyser_stream_errors");
        scheduleReconnect();
      });

      stream.on("end", () => {
        if (isClosed) return;
        logger.info({}, "geyser stream ended");
        scheduleReconnect();
      });

      await writeSubscribeRequest(stream, request);
    } catch (error) {
      logger.error({ err: serializeError(error) }, "failed to establish geyser subscription");
      metrics.incrementCounter("geyser_stream_connect_errors");
      scheduleReconnect();
    }
  };

  const scheduleReconnect = () => {
    if (isClosed) return;

    if (reconnectTimer !== null) {
      return;
    }

    const delay = reconnectDelay;
    reconnectDelay = Math.min(reconnectDelay * 2, reconnectConfig.max);
    metrics.incrementCounter("geyser_stream_reconnect_attempts");
    logger.info({ delayMs: delay }, "scheduling geyser reconnect");

    reconnectTimer = setTimeout(() => {
      reconnectTimer = null;
      connect().catch((error) => {
        logger.error({ err: serializeError(error) }, "geyser reconnect attempt failed unexpectedly");
      });
    }, delay) as unknown as number;
  };

  await connect();

  return {
    close: () => {
      isClosed = true;
      if (reconnectTimer !== null) {
        clearTimeout(reconnectTimer);
        reconnectTimer = null;
      }
      if (stream) {
        stream.end();
        stream.removeAllListeners();
      }
    },
  };
}

function processUpdate(
  update: SubscribeUpdate,
  deps: { config: FreshSniperConfig; logger: Logger; metrics: MetricsClient; eventBus: EventEmitter },
) {
  if (!update.transaction) {
    return;
  }

  const { logger, metrics, eventBus } = deps;
  const filters = update.filters ?? [];

  // Ensure the update belongs to one of our configured Pump.fun program filters.
  const isPumpfunUpdate = filters.some((filter) => filter.startsWith("pumpfun-program-"));
  if (!isPumpfunUpdate) {
    return;
  }

  const txInfo = update.transaction.transaction ?? update.transaction;
  const meta = txInfo.meta ?? update.transaction.meta;
  if (!meta) {
    return;
  }

  const mintedTokens = extractMintedTokens(meta);
  if (mintedTokens.length === 0) {
    return;
  }

  const signature = normalizeSignature(txInfo.signature ?? update.transaction.signature);
  const slot = update.transaction.slot ?? null;

  const payload = {
    type: "TokenCreated" as const,
    signature,
    slot,
    filters,
    mintedTokens,
    receivedAt: Date.now(),
    logMessages: meta.logMessages ?? [],
  };

  metrics.incrementCounter("pumpfun_new_creation_events");
  metrics.reportLoopSummary({
    loop: "geyser_pumpfun_creation",
    signature: payload.signature,
    slot: payload.slot,
    mintedCount: mintedTokens.length,
  });

  eventBus.emit("pumpfun:tokenCreated", payload);
  logger.debug({ signature: payload.signature, slot, mintedTokens }, "pumpfun token creation detected");
}

function buildSubscribeRequest(config: FreshSniperConfig): SubscribeRequest {
  const transactionsFilters = Object.fromEntries(
    config.geyser.subscriptions.pumpfun_program_ids.map((programId, index) => [
      `pumpfun-program-${index}`,
      buildTransactionFilter(programId),
    ]),
  );

  const walletFilters =
    config.geyser.subscriptions.wallet_addresses.length > 0
      ? {
          "wallet-monitor": {
            vote: false,
            failed: false,
            signature: undefined,
            accountInclude: config.geyser.subscriptions.wallet_addresses,
            accountExclude: [],
            accountRequired: [],
          } as SubscribeRequestFilterTransactions,
        }
      : undefined;

  const commitment = normalizeCommitment(config.rpc.commitment);

  const request: SubscribeRequest = {
    accounts: {},
    slots: {},
    transactions: transactionsFilters,
    transactionsStatus: walletFilters,
    blocks: {},
    blocksMeta: {},
    entry: {},
    accountsDataSlice: [],
    ping: undefined,
    commitment,
  };

  return request;
}

function buildTransactionFilter(programId: string): SubscribeRequestFilterTransactions {
  return {
    vote: false,
    failed: false,
    signature: undefined,
    accountInclude: [programId],
    accountExclude: [],
    accountRequired: [],
  };
}

function normalizeCommitment(commitment: string): CommitmentLevel {
  const normalized = commitment.toLowerCase();
  switch (normalized) {
    case "processed":
      return CommitmentLevel.PROCESSED;
    case "confirmed":
      return CommitmentLevel.CONFIRMED;
    case "finalized":
      return CommitmentLevel.FINALIZED;
    default:
      return CommitmentLevel.PROCESSED;
  }
}

function extractMintedTokens(meta: { preTokenBalances?: any[]; postTokenBalances?: any[] }): MintedTokenInfo[] {
  const preMints = new Set<string>();
  for (const entry of meta.preTokenBalances ?? []) {
    const mint = typeof entry?.mint === "string" ? entry.mint : undefined;
    if (mint) {
      preMints.add(mint);
    }
  }

  const minted: MintedTokenInfo[] = [];
  for (const entry of meta.postTokenBalances ?? []) {
    const mint = typeof entry?.mint === "string" ? entry.mint : undefined;
    if (!mint || preMints.has(mint)) {
      continue;
    }

    const amountRaw = entry?.uiTokenAmount?.amount ?? entry?.uiTokenAmount?.uiAmountString ?? "0";
    const amountUi = entry?.uiTokenAmount?.uiAmount;
    const amountUiString = entry?.uiTokenAmount?.uiAmountString ?? entry?.uiTokenAmount?.amount;

    minted.push({
      mint,
      owner: typeof entry?.owner === "string" ? entry.owner : "",
      programId: typeof entry?.programId === "string" ? entry.programId : "",
      amountRaw,
      amountUi,
      amountUiString,
    });
  }

  return minted;
}

function normalizeSignature(signature: unknown): string | null {
  if (!signature) {
    return null;
  }

  if (typeof signature === "string") {
    // Try base64 decode first; fallback to raw string if not base64.
    const decoded = safeBase64Decode(signature);
    if (decoded) {
      return encodeBase58(decoded);
    }
    return signature;
  }

  if (signature instanceof Uint8Array) {
    return encodeBase58(signature);
  }

  if (Array.isArray(signature)) {
    return encodeBase58(Uint8Array.from(signature as number[]));
  }

  return null;
}

function safeBase64Decode(value: string): Uint8Array | null {
  try {
    const buffer = Buffer.from(value, "base64");
    if (buffer.length === 0) {
      return null;
    }
    return buffer;
  } catch (error) {
    return null;
  }
}

function encodeBase58(bytes: Uint8Array): string {
  if (bytes.length === 0) {
    return "";
  }

  const alphabet = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
  const digits = [0];

  for (const byte of bytes) {
    let carry = byte;
    for (let j = 0; j < digits.length; j += 1) {
      carry += digits[j] << 8;
      digits[j] = carry % 58;
      carry = Math.floor(carry / 58);
    }

    while (carry > 0) {
      digits.push(carry % 58);
      carry = Math.floor(carry / 58);
    }
  }

  let leadingZeroCount = 0;
  for (const byte of bytes) {
    if (byte === 0) {
      leadingZeroCount += 1;
    } else {
      break;
    }
  }

  let result = "";
  for (let i = 0; i < leadingZeroCount; i += 1) {
    result += "1";
  }
  for (let i = digits.length - 1; i >= 0; i -= 1) {
    result += alphabet[digits[i]];
  }
  return result;
}

async function writeSubscribeRequest(stream: YellowstoneStream, request: SubscribeRequest): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    stream.write(request, (err) => {
      if (err) {
        reject(err);
      } else {
        resolve();
      }
    });
  });
}

function serializeError(error: unknown): Record<string, unknown> {
  if (error instanceof Error) {
    return { message: error.message, stack: error.stack };
  }
  return { message: String(error) };
}

function createYellowstoneClient(endpoint: string, token?: string): YellowstoneClient {
  return new YellowstoneClient(endpoint, token, undefined);
}
