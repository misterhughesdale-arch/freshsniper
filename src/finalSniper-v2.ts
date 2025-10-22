import "dotenv/config";
import bs58 from "bs58";
import {
  Connection,
  Keypair,
  PublicKey,
  Transaction,
  SystemProgram,
  TransactionInstruction,
  ComputeBudgetProgram,
  LAMPORTS_PER_SOL,
  AccountInfo,
} from "@solana/web3.js";
import {
  TOKEN_PROGRAM_ID,
  getAssociatedTokenAddressSync,
  createAssociatedTokenAccountInstruction,
  createCloseAccountInstruction,
} from "@solana/spl-token";
import Client, {
  CommitmentLevel,
  SubscribeRequest,
} from "@triton-one/yellowstone-grpc";
import BN from "bn.js";
import { TradeLogger, FeeMetrics } from "./utils/sqliteLogger";
import {
  getHeliusTipLamports,
  getRandomJitoTipAccount,
  sendViaHeliusSender,
} from "./pumpUtils";
import readline from "readline";

// ============================================================================
// CONFIGURATION
// ============================================================================

const CONFIG = {
  PUMP_PROGRAM: new PublicKey("6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P"),
  PUMP_TOKEN_PROGRAM: "TSLvdd1pWpHVjahSpsvCXUbgwsL3JAcvokwaKt1eokM",
  PUMP_GLOBAL: new PublicKey("4wTV1YmiEkRvAtNtsSGPtUrqRYQMe5SKy2uB4Jjaxnjf"),
  PUMP_FEE_RECIPIENT: new PublicKey(
    "CebN5WGQ4jvEPvsVU4EoHEpgzq1VV7AbicfhtW4xC9iM",
  ),
  PUMP_EVENT_AUTHORITY: new PublicKey(
    "Ce6TQqeHC9p8KetsN6JsjHK7UTZk7nasjjnr7XxXp9F1",
  ),
  PUMP_FEE_PROGRAM: new PublicKey(
    "pfeeUxB6jkeY1Hxd7CsFCAjcbHA9rWtchMGdZ6VojVZ",
  ),
  BUY_AMOUNT_SOL: Number(process.env.BUY_AMOUNT_SOL) || 0.03,
  SELL_TIMEOUT_MS: 60000, // 60 seconds
  SLIPPAGE_BPS: 500,
  COMPUTE_UNITS: 200000, // Increased to prevent ProgramFailedToComplete
  COMPUTE_UNITS_SELL: 150000,
  EXECUTE: process.env.EXECUTE !== "false",
  USE_DUST_SELL: process.env.USE_DUST_SELL === "true",

  // Helius sender configuration
  HELIUS_SENDER_URL:
    process.env.HELIUS_SENDER_URL || "https://sg-sender.helius-rpc.com/fast",
  USE_HELIUS_SENDER: process.env.USE_HELIUS_SENDER !== "false",
  HELIUS_TIP_SOL: Number(process.env.HELIUS_TIP_SOL) || 0.001,
  STOP_LOSS_TIMEOUT_MS: Number(process.env.STOP_LOSS_TIMEOUT_MS) || 20000,
  STOP_LOSS_THRESHOLD_BPS: Number(process.env.STOP_LOSS_THRESHOLD_BPS) || 4000,
  NO_ACTIVITY_TIMEOUT_MS: Number(process.env.NO_ACTIVITY_TIMEOUT_MS) || 10000,

  // Advanced settings
  MAX_POSITION_SIZE_PERCENT: 2, // Max 2% of liquidity
  DYNAMIC_SLIPPAGE: process.env.DYNAMIC_SLIPPAGE === "true",
  SIMULATE_BEFORE_SEND: process.env.SIMULATE_BEFORE_SEND === "true", // Default false (simulation has false positives)

  // Circuit breaker
  MAX_CONSECUTIVE_FAILURES: 3,
  CIRCUIT_BREAKER_RESET_MS: 30000, // 30 seconds
  MIN_WALLET_BALANCE_SOL: 0.03,
};

const DISCRIMINATORS = {
  BUY: Buffer.from([0x66, 0x06, 0x3d, 0x12, 0x01, 0xda, 0xeb, 0xea]),
  SELL: Buffer.from([0x33, 0xe6, 0x85, 0xa4, 0x01, 0x7f, 0x83, 0xad]),
};

// ============================================================================
// STATE MANAGEMENT
// ============================================================================

interface CachedBlockhash {
  blockhash: string;
  lastValidBlockHeight: number;
  timestamp: number;
}

interface PriorityFeeCache {
  p50: number;
  p75: number;
  p95: number;
  p99: number;
  timestamp: number;
}

interface Position {
  mint: PublicKey;
  creator: PublicKey;
  buyTimestamp: number;
  signature: string;
  isConfirmed: boolean;
  otherBuysDetected: boolean;
  sellTimeout: NodeJS.Timeout;
  bondingCurveData?: BondingCurveData;
  stopLossTimeout?: NodeJS.Timeout;
  noActivityTimeout?: NodeJS.Timeout;
}

interface BondingCurveData {
  virtualTokenReserves: bigint;
  virtualSolReserves: bigint;
  realTokenReserves: bigint;
  realSolReserves: bigint;
}

interface CircuitBreakerState {
  isOpen: boolean;
  consecutiveFailures: number;
  lastFailureTime: number;
  resetTimeout?: NodeJS.Timeout;
}

// Global state
let blockhashCache: CachedBlockhash | null = null;
let priorityFeeCache: PriorityFeeCache | null = null;
const processedTokens = new Set<string>();
const activePositions = new Map<string, Position>();

// Rate limiting / trading state
let lastBuyTime = 0;
const BUY_COOLDOWN_MS = 60000;

// Transaction tracking
const unconfirmedTransactions = new Map<
  string,
  { mint: string; timestamp: number }
>();
const confirmedUnsoldTransactions = new Map<
  string,
  { mint: string; timestamp: number }
>();

// Pending buys waiting for stream confirmation (CRITICAL: Don't rely on confirmTransaction!)
const pendingBuys = new Map<
  string,
  {
    mint: PublicKey;
    mintStr: string;
    creator: PublicKey;
    signature: string;
    timestamp: number;
    sellTimeoutMs: number;
  }
>();

// Circuit breaker
const circuitBreaker: CircuitBreakerState = {
  isOpen: false,
  consecutiveFailures: 0,
  lastFailureTime: 0,
};

// Startup cleanup
let startupCleanupDone = false;
let startupCleanupInProgress = false;

// Performance metrics
interface PerformanceMetrics {
  totalBuys: number;
  totalSells: number;
  successfulBuys: number;
  successfulSells: number;
  failedBuys: number;
  failedSells: number;
  avgBuyLatency: number;
  avgSellLatency: number;
  totalGasSpent: number;
}

const metrics: PerformanceMetrics = {
  totalBuys: 0,
  totalSells: 0,
  successfulBuys: 0,
  successfulSells: 0,
  failedBuys: 0,
  failedSells: 0,
  avgBuyLatency: 0,
  avgSellLatency: 0,
  totalGasSpent: 0,
};

const BASE_FEE_LAMPORTS_ESTIMATE = 5_000;
const DEFAULT_BUY_SLIPPAGE_BPS = 500;

function calculatePriorityLamports(
  priorityMicroLamportsPerCu: number,
  computeUnits: number,
): number {
  if (!Number.isFinite(priorityMicroLamportsPerCu)) {
    return 0;
  }
  return Math.max(
    0,
    Math.floor((priorityMicroLamportsPerCu * computeUnits) / 1_000_000),
  );
}

async function promptHighFeeConfirmation(
  context: string,
  percent: number,
): Promise<boolean> {
  const env = (process.env.AUTO_CONFIRM_HIGH_FEES ?? "").trim().toLowerCase();
  if (env === "true") {
    log(
      "WARN",
      `⚠️ High fee ratio ${percent.toFixed(
        2,
      )}% for ${context} – auto-confirming due to AUTO_CONFIRM_HIGH_FEES=true`,
    );
    return true;
  }
  if (env === "false") {
    return false;
  }
  if (!process.stdin.isTTY || !process.stdout.isTTY) {
    log(
      "WARN",
      `⚠️ High fee ratio ${percent.toFixed(
        2,
      )}% for ${context} but environment is non-interactive – refusing. Set AUTO_CONFIRM_HIGH_FEES=true to override.`,
    );
    return false;
  }

  return await new Promise<boolean>((resolve) => {
    const rl = readline.createInterface({
      input: process.stdin,
      output: process.stdout,
    });
    rl.question(
      `[${context}] Fee ratio ${percent.toFixed(
        2,
      )}% exceeds 5%. Continue? (y/N): `,
      (answer) => {
        rl.close();
        resolve(/^y(es)?$/i.test(answer.trim()));
      },
    );
  });
}

async function enforceFeeBudget(
  context: string,
  valueLamports: number,
  feeLamports: number,
): Promise<void> {
  const spendLamports = Math.max(valueLamports, 0);
  const totalLamports = spendLamports + feeLamports;
  if (totalLamports <= 0) {
    return;
  }

  const ratio = feeLamports / totalLamports;
  if (ratio <= 0.02) {
    return;
  }

  const percent = ratio * 100;
  if (ratio >= 0.1) {
    log(
      "ERROR",
      `❌ Fee ratio ${percent.toFixed(2)}% for ${context} exceeds 10% threshold`,
    );
    throw new Error("Fee ratio exceeds 10% of transaction cost");
  }

  if (ratio > 0.05) {
    log(
      "WARN",
      `⚠️ Fee ratio ${percent.toFixed(
        2,
      )}% for ${context} exceeds 5% threshold – confirmation required`,
    );
    const confirmed = await promptHighFeeConfirmation(context, percent);
    if (!confirmed) {
      throw new Error("High fee ratio rejected by user");
    }
    return;
  }

  log(
    "WARN",
    `⚠️ Fee ratio ${percent.toFixed(2)}% for ${context} exceeds 2% threshold`,
  );
}

function clearPositionTimers(position: Position) {
  clearTimeout(position.sellTimeout);
  if (position.stopLossTimeout) {
    clearTimeout(position.stopLossTimeout);
    position.stopLossTimeout = undefined;
  }
  if (position.noActivityTimeout) {
    clearTimeout(position.noActivityTimeout);
    position.noActivityTimeout = undefined;
  }
}

function trackPosition(
  connection: Connection,
  wallet: Keypair,
  mint: PublicKey,
  creator: PublicKey,
  mintStr: string,
  signature: string,
  sellTimeoutMs: number,
  tradeLogger: TradeLogger,
  isConfirmed: boolean = false,
) {
  const existing = activePositions.get(mintStr);
  const carryOverCurve = existing?.bondingCurveData;
  const carryOverOtherBuys = existing?.otherBuysDetected ?? false;
  if (existing) {
    clearPositionTimers(existing);
  }
  const confirmedState = isConfirmed || (existing?.isConfirmed ?? false);

  const scheduleSellTimeout = (): NodeJS.Timeout => {
    const handler = async () => {
      const position = activePositions.get(mintStr);
      if (!position) {
        return;
      }
      if (!position.isConfirmed) {
        position.sellTimeout = setTimeout(handler, 1000);
        return;
      }
      if (position.otherBuysDetected) {
        return;
      }
      log("INFO", `⏰ ${sellTimeoutMs}ms timeout - selling ${mintStr}`);
      await executeSell(
        connection,
        wallet,
        mint,
        creator,
        mintStr,
        `${sellTimeoutMs}ms timeout`,
        tradeLogger,
      );
    };
    return setTimeout(handler, sellTimeoutMs);
  };

  const sellTimeout = scheduleSellTimeout();

  let stopLossTimeout: NodeJS.Timeout | undefined;
  if (CONFIG.STOP_LOSS_TIMEOUT_MS > 0 && CONFIG.STOP_LOSS_THRESHOLD_BPS > 0) {
    const stopLossHandler = async () => {
      const position = activePositions.get(mintStr);
      if (!position || position.otherBuysDetected) {
        return;
      }
      if (!position.isConfirmed) {
        position.stopLossTimeout = setTimeout(stopLossHandler, 1000);
        return;
      }
      try {
        const trade = tradeLogger.getOpenTrade(mintStr);
        if (!trade) {
          return;
        }

        const ata = getAssociatedTokenAddressSync(mint, wallet.publicKey);
        const acc = await connection.getAccountInfo(ata);
        if (!acc || acc.data.length < 72) {
          return;
        }
        const balance = acc.data.readBigUInt64LE(64);
        if (balance === 0n) {
          return;
        }

        const estimatedLamports = await estimateSellProceedsLamports(
          connection,
          mint,
          balance,
        );
        if (estimatedLamports === null) {
          return;
        }

        const buySolAbs = Math.abs(trade.buy_sol ?? CONFIG.BUY_AMOUNT_SOL);
        const thresholdLamports = Math.floor(
          buySolAbs *
            LAMPORTS_PER_SOL *
            (CONFIG.STOP_LOSS_THRESHOLD_BPS / 10000),
        );
        if (thresholdLamports <= 0) {
          return;
        }

        if (estimatedLamports >= thresholdLamports) {
          log(
            "DEBUG",
            `Stop-loss check: ${mintStr} est ${(
              estimatedLamports / LAMPORTS_PER_SOL
            ).toFixed(6)} SOL >= ${(
              thresholdLamports / LAMPORTS_PER_SOL
            ).toFixed(6)} SOL`,
          );
          return;
        }

        log(
          "INFO",
          `⛔ STOP-LOSS ${mintStr}: est ${(
            estimatedLamports / LAMPORTS_PER_SOL
          ).toFixed(6)} SOL < ${(thresholdLamports / LAMPORTS_PER_SOL).toFixed(
            6,
          )} SOL – selling`,
        );
        clearPositionTimers(position);
        await executeSell(
          connection,
          wallet,
          mint,
          creator,
          mintStr,
          "stop-loss threshold",
          tradeLogger,
        );
      } catch (err) {
        log("WARN", `Stop-loss evaluation failed for ${mintStr}: ${err}`);
      }
    };
    stopLossTimeout = setTimeout(stopLossHandler, CONFIG.STOP_LOSS_TIMEOUT_MS);
  }

  let noActivityTimeout: NodeJS.Timeout | undefined;
  if (CONFIG.NO_ACTIVITY_TIMEOUT_MS > 0) {
    const noActivityHandler = async () => {
      const position = activePositions.get(mintStr);
      if (!position || position.otherBuysDetected) {
        return;
      }
      if (!position.isConfirmed) {
        position.noActivityTimeout = setTimeout(noActivityHandler, 1000);
        return;
      }
      log(
        "INFO",
        `⏱️ No follow-through on ${mintStr} within ${CONFIG.NO_ACTIVITY_TIMEOUT_MS}ms – selling`,
      );
      clearPositionTimers(position);
      await executeSell(
        connection,
        wallet,
        mint,
        creator,
        mintStr,
        "no-follow-through",
        tradeLogger,
      );
    };
    noActivityTimeout = setTimeout(
      noActivityHandler,
      CONFIG.NO_ACTIVITY_TIMEOUT_MS,
    );
  }

  activePositions.set(mintStr, {
    mint,
    creator,
    buyTimestamp: Date.now(),
    signature,
    isConfirmed: confirmedState,
    otherBuysDetected: carryOverOtherBuys,
    sellTimeout,
    stopLossTimeout,
    noActivityTimeout,
    bondingCurveData: carryOverCurve,
  });

  confirmedUnsoldTransactions.set(signature, {
    mint: mintStr,
    timestamp: Date.now(),
  });
}

function cancelPositionTracking(
  mintStr: string,
  signature?: string,
  logReason?: string,
) {
  const position = activePositions.get(mintStr);
  if (position) {
    clearPositionTimers(position);
    activePositions.delete(mintStr);
    if (logReason) {
      log("INFO", `🗑️ Position ${mintStr} cleared (${logReason})`);
    }
  }

  if (signature) {
    confirmedUnsoldTransactions.delete(signature);
  } else {
    for (const [sig, data] of Array.from(
      confirmedUnsoldTransactions.entries(),
    )) {
      if (data.mint === mintStr) {
        confirmedUnsoldTransactions.delete(sig);
      }
    }
  }
}

function setBlockhashForTests(
  blockhash: string,
  lastValidBlockHeight: number = 0,
) {
  blockhashCache = {
    blockhash,
    lastValidBlockHeight,
    timestamp: Date.now(),
  };
}

type DetectionSnapshot = {
  shouldBuy: boolean;
  reason: string;
  cooldownRemainingMs: number;
  unconfirmedTransactions: number;
  confirmedUnsold: number;
  pendingBuys: number;
  circuitBreakerOpen: boolean;
};

function evaluateBuyReadinessForTest(
  mint: string,
  now: number,
  persist: boolean = false,
): DetectionSnapshot {
  const alreadyProcessed = processedTokens.has(mint);
  const timeSinceLastBuy = now - lastBuyTime;
  const cooldownRemainingMs = Math.max(0, BUY_COOLDOWN_MS - timeSinceLastBuy);
  const unconfirmed = unconfirmedTransactions.size;
  const confirmed = confirmedUnsoldTransactions.size;
  const pending = pendingBuys.size;
  const circuitOpen = circuitBreaker.isOpen;

  let reason = "ok";
  let shouldBuy = true;

  if (circuitOpen) {
    reason = "circuit";
    shouldBuy = false;
  } else if (alreadyProcessed) {
    reason = "processed";
    shouldBuy = false;
  } else if (cooldownRemainingMs > 0) {
    reason = "cooldown";
    shouldBuy = false;
  } else if (pending > 0) {
    reason = "pending";
    shouldBuy = false;
  } else if (unconfirmed > 1) {
    reason = "unconfirmed";
    shouldBuy = false;
  } else if (confirmed > 0) {
    reason = "unsold";
    shouldBuy = false;
  }

  if (shouldBuy && persist) {
    processedTokens.add(mint);
    lastBuyTime = now;
  }

  return {
    shouldBuy,
    reason,
    cooldownRemainingMs,
    unconfirmedTransactions: unconfirmed,
    confirmedUnsold: confirmed,
    pendingBuys: pending,
    circuitBreakerOpen: circuitOpen,
  };
}

function resetStateForTests() {
  processedTokens.clear();
  activePositions.clear();
  unconfirmedTransactions.clear();
  confirmedUnsoldTransactions.clear();
  pendingBuys.clear();
  circuitBreaker.isOpen = false;
  circuitBreaker.consecutiveFailures = 0;
  circuitBreaker.lastFailureTime = 0;
  if (circuitBreaker.resetTimeout) {
    clearTimeout(circuitBreaker.resetTimeout);
    circuitBreaker.resetTimeout = undefined;
  }
  blockhashCache = null;
  priorityFeeCache = null;
  lastBuyTime = 0;
  startupCleanupDone = false;
  startupCleanupInProgress = false;
  metrics.totalBuys = 0;
  metrics.totalSells = 0;
  metrics.successfulBuys = 0;
  metrics.successfulSells = 0;
  metrics.failedBuys = 0;
  metrics.failedSells = 0;
  metrics.avgBuyLatency = 0;
  metrics.avgSellLatency = 0;
  metrics.totalGasSpent = 0;
}

// ============================================================================
// LOGGING
// ============================================================================

function log(level: string, msg: string, meta?: any) {
  const timestamp = new Date().toISOString();
  const metaStr = meta ? ` ${JSON.stringify(meta)}` : "";
  console.log(`[${timestamp}] [${level}] ${msg}${metaStr}`);
}

// ============================================================================
// CIRCUIT BREAKER
// ============================================================================

function tripCircuitBreaker(reason: string): void {
  circuitBreaker.isOpen = true;
  circuitBreaker.consecutiveFailures++;
  circuitBreaker.lastFailureTime = Date.now();

  log("ERROR", `🔴 CIRCUIT BREAKER TRIPPED: ${reason}`, {
    consecutiveFailures: circuitBreaker.consecutiveFailures,
  });

  // Auto-reset after timeout
  if (circuitBreaker.resetTimeout) {
    clearTimeout(circuitBreaker.resetTimeout);
  }

  circuitBreaker.resetTimeout = setTimeout(() => {
    circuitBreaker.isOpen = false;
    circuitBreaker.consecutiveFailures = 0;
    log("INFO", "🟢 Circuit breaker reset - resuming operations");
  }, CONFIG.CIRCUIT_BREAKER_RESET_MS);
}

function recordSuccess(): void {
  circuitBreaker.consecutiveFailures = 0;
  if (circuitBreaker.isOpen) {
    circuitBreaker.isOpen = false;
    log("INFO", "🟢 Circuit breaker closed after success");
  }
}

function checkCircuitBreaker(): boolean {
  if (circuitBreaker.isOpen) {
    const timeSinceTrip = Date.now() - circuitBreaker.lastFailureTime;
    log(
      "WARN",
      `⏸️  Circuit breaker is open (${(timeSinceTrip / 1000).toFixed(1)}s ago)`,
    );
    return false;
  }
  return true;
}

// ============================================================================
// PDA DERIVATION HELPERS
// ============================================================================

function findCreatorVault(creator: PublicKey): PublicKey {
  const [pda] = PublicKey.findProgramAddressSync(
    [Buffer.from("creator-vault"), creator.toBuffer()],
    CONFIG.PUMP_PROGRAM,
  );
  return pda;
}

function findGlobalVolumeAccumulator(): PublicKey {
  const [pda] = PublicKey.findProgramAddressSync(
    [Buffer.from("global_volume_accumulator")],
    CONFIG.PUMP_PROGRAM,
  );
  return pda;
}

function findUserVolumeAccumulator(user: PublicKey): PublicKey {
  const [pda] = PublicKey.findProgramAddressSync(
    [Buffer.from("user_volume_accumulator"), user.toBuffer()],
    CONFIG.PUMP_PROGRAM,
  );
  return pda;
}

function findFeeConfig(): PublicKey {
  const constant = Buffer.from([
    1, 86, 224, 246, 147, 102, 90, 207, 68, 219, 21, 104, 191, 23, 91, 170, 81,
    137, 203, 151, 245, 210, 255, 59, 101, 93, 43, 182, 253, 109, 24, 176,
  ]);
  const [pda] = PublicKey.findProgramAddressSync(
    [Buffer.from("fee_config"), constant],
    CONFIG.PUMP_FEE_PROGRAM,
  );
  return pda;
}

// ============================================================================
// CACHE MANAGEMENT (Background Updates)
// ============================================================================

async function startBlockhashCache(connection: Connection): Promise<void> {
  const updateBlockhash = async () => {
    try {
      const { blockhash, lastValidBlockHeight } =
        await connection.getLatestBlockhash("finalized");
      blockhashCache = {
        blockhash,
        lastValidBlockHeight,
        timestamp: Date.now(),
      };
    } catch (err) {
      log("WARN", `Failed to update blockhash cache: ${err}`);
    }
  };

  // Initial fetch
  await updateBlockhash();

  // Update every 400ms
  setInterval(updateBlockhash, 400);
  log("INFO", "✅ Blockhash cache started (400ms refresh)");
}

async function startPriorityFeeCache(connection: Connection): Promise<void> {
  const updateFees = async () => {
    try {
      const fees = await (connection as any).getRecentPrioritizationFees?.();
      if (Array.isArray(fees) && fees.length > 0) {
        const values = fees
          .map((f: any) => Number(f?.prioritizationFee) || 0)
          .filter((v: number) => Number.isFinite(v) && v >= 0)
          .sort((a: number, b: number) => a - b);

        if (values.length > 0) {
          const getPercentile = (p: number) => {
            const idx = Math.min(
              values.length - 1,
              Math.max(0, Math.floor((p / 100) * values.length) - 1),
            );
            return values[idx];
          };

          priorityFeeCache = {
            p50: Math.max(getPercentile(50), 5000),
            p75: Math.max(getPercentile(75), 10000),
            p95: Math.max(getPercentile(95), 25000),
            p99: Math.max(getPercentile(99), 50000),
            timestamp: Date.now(),
          };
        }
      }
    } catch (err) {
      log("WARN", `Failed to update priority fee cache: ${err}`);
    }
  };

  // Initial fetch
  await updateFees();

  // Update every 3 seconds
  setInterval(updateFees, 3000);
  log("INFO", "✅ Priority fee cache started (3s refresh)");
}

function getCachedPriorityFee(percentile: 50 | 75 | 95 | 99 = 75): number {
  if (!priorityFeeCache) {
    return 25000; // Fallback
  }

  const ageMs = Date.now() - priorityFeeCache.timestamp;
  if (ageMs > 10000) {
    log("WARN", `Priority fee cache is stale (${ageMs}ms old)`);
  }

  return priorityFeeCache[`p${percentile}`] || 25000;
}

function getDynamicPriorityMicroLamports(
  _computeUnits: number,
  fallbackPercentile: 50 | 75 | 95 | 99 = 75,
): number {
  return getCachedPriorityFee(fallbackPercentile);
}

function getCachedBlockhash(): string | null {
  if (!blockhashCache) {
    return null;
  }

  const ageMs = Date.now() - blockhashCache.timestamp;
  if (ageMs > 2000) {
    log("WARN", `Blockhash cache is stale (${ageMs}ms old)`);
  }

  return blockhashCache.blockhash;
}

// ============================================================================
// DYNAMIC SLIPPAGE CALCULATION
// ============================================================================

function calculateDynamicSlippage(
  bondingCurveData: BondingCurveData,
  buyAmountSol: number,
): number {
  if (!CONFIG.DYNAMIC_SLIPPAGE) {
    return CONFIG.SLIPPAGE_BPS;
  }

  try {
    const buyAmountLamports = BigInt(
      Math.floor(buyAmountSol * LAMPORTS_PER_SOL),
    );
    const { virtualSolReserves, virtualTokenReserves } = bondingCurveData;

    // Constant product: k = x * y
    // After buy: (x + dx) * (y - dy) = k
    // dy = y * dx / (x + dx)
    const tokensOut =
      (virtualTokenReserves * buyAmountLamports) /
      (virtualSolReserves + buyAmountLamports);

    // Calculate price impact
    const priceImpact =
      Number((tokensOut * BigInt(10000)) / virtualTokenReserves) / 10000;

    // Add buffer: 1.5x price impact + 200 BPS minimum
    const dynamicSlippage = Math.max(
      Math.floor(priceImpact * 15000), // 1.5x impact in BPS
      200, // 2% minimum
    );

    log("DEBUG", `Dynamic slippage calculated: ${dynamicSlippage} BPS`, {
      priceImpact: (priceImpact * 100).toFixed(2) + "%",
      virtualSolReserves: virtualSolReserves.toString(),
    });

    return Math.min(dynamicSlippage, 1000); // Cap at 10%
  } catch (err) {
    log("WARN", `Failed to calculate dynamic slippage: ${err}`);
    return CONFIG.SLIPPAGE_BPS;
  }
}

async function estimateSellProceedsLamports(
  connection: Connection,
  mint: PublicKey,
  tokenAmount: bigint,
): Promise<number | null> {
  if (tokenAmount <= 0n) {
    return null;
  }

  try {
    const [bondingCurve] = PublicKey.findProgramAddressSync(
      [Buffer.from("bonding-curve"), mint.toBuffer()],
      CONFIG.PUMP_PROGRAM,
    );
    const bondingCurveInfo = await connection.getAccountInfo(bondingCurve);
    if (!bondingCurveInfo || bondingCurveInfo.data.length < 24) {
      return null;
    }

    const data = bondingCurveInfo.data;
    const virtualTokenReserves = data.readBigUInt64LE(8);
    const virtualSolReserves = data.readBigUInt64LE(16);

    if (virtualTokenReserves === 0n || virtualSolReserves === 0n) {
      return null;
    }

    const k = virtualTokenReserves * virtualSolReserves;
    const newTokenReserves = virtualTokenReserves + tokenAmount;
    if (newTokenReserves === 0n) {
      return null;
    }

    const newSolReserves = k / newTokenReserves;
    if (newSolReserves >= virtualSolReserves) {
      return null;
    }

    const solOut = virtualSolReserves - newSolReserves;
    if (solOut <= 0n) {
      return null;
    }

    const buffered = (solOut * 95n) / 100n;
    if (buffered <= 0n) {
      return null;
    }

    const lamports = Number(buffered);
    if (!Number.isFinite(lamports)) {
      return null;
    }

    return Math.max(1, lamports);
  } catch (err) {
    log("WARN", `Failed to estimate sell proceeds: ${err}`);
    return null;
  }
}

// ============================================================================
// TRANSACTION BUILDING
// ============================================================================

async function buildBuyTx(
  connection: Connection,
  wallet: Keypair,
  mint: PublicKey,
  creator: PublicKey,
  priorityFee: number,
  blockhash: string,
  bondingCurveData?: BondingCurveData,
): Promise<Transaction> {
  const tx = new Transaction();

  tx.add(
    ComputeBudgetProgram.setComputeUnitLimit({ units: CONFIG.COMPUTE_UNITS }),
  );
  tx.add(
    ComputeBudgetProgram.setComputeUnitPrice({ microLamports: priorityFee }),
  );

  const [bondingCurve] = PublicKey.findProgramAddressSync(
    [Buffer.from("bonding-curve"), mint.toBuffer()],
    CONFIG.PUMP_PROGRAM,
  );

  const associatedBondingCurve = getAssociatedTokenAddressSync(
    mint,
    bondingCurve,
    true,
  );
  const buyerAta = getAssociatedTokenAddressSync(mint, wallet.publicKey);

  const creatorVault = findCreatorVault(creator);
  const globalVolumeAccumulator = findGlobalVolumeAccumulator();
  const userVolumeAccumulator = findUserVolumeAccumulator(wallet.publicKey);
  const feeConfig = findFeeConfig();

  // Check if ATA exists (parallel with account fetch if needed)
  try {
    const ataInfo = await connection.getAccountInfo(buyerAta);
    if (!ataInfo) {
      tx.add(
        createAssociatedTokenAccountInstruction(
          wallet.publicKey,
          buyerAta,
          wallet.publicKey,
          mint,
        ),
      );
    }
  } catch {}

  // Calculate slippage dynamically if bonding curve data available
  // Note: Currently using static token amount, dynamic slippage calculation ready for future use
  if (bondingCurveData) {
    calculateDynamicSlippage(bondingCurveData, CONFIG.BUY_AMOUNT_SOL);
  }

  // Estimate token amount using observed early curve (~3.5M tokens per 0.1 SOL ≈ 35M per SOL)
  const tokensPerSolFallback = 35_000_000;
  const requestedTokens = Math.floor(
    CONFIG.BUY_AMOUNT_SOL * tokensPerSolFallback,
  );
  const tokenAmount = BigInt(requestedTokens * 1_000_000);

  // CRITICAL FIX: Add 5% slippage protection
  // Without slippage, any price movement causes transaction failure
  const slippageBpsBuy = DEFAULT_BUY_SLIPPAGE_BPS;
  const maxSolCost = Math.floor(
    CONFIG.BUY_AMOUNT_SOL * LAMPORTS_PER_SOL * (1 + slippageBpsBuy / 10000),
  );

  tx.add(
    new TransactionInstruction({
      programId: CONFIG.PUMP_PROGRAM,
      keys: [
        { pubkey: CONFIG.PUMP_GLOBAL, isSigner: false, isWritable: false },
        {
          pubkey: CONFIG.PUMP_FEE_RECIPIENT,
          isSigner: false,
          isWritable: true,
        },
        { pubkey: mint, isSigner: false, isWritable: false },
        { pubkey: bondingCurve, isSigner: false, isWritable: true },
        { pubkey: associatedBondingCurve, isSigner: false, isWritable: true },
        { pubkey: buyerAta, isSigner: false, isWritable: true },
        { pubkey: wallet.publicKey, isSigner: true, isWritable: true },
        { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
        { pubkey: TOKEN_PROGRAM_ID, isSigner: false, isWritable: false },
        { pubkey: creatorVault, isSigner: false, isWritable: true },
        {
          pubkey: CONFIG.PUMP_EVENT_AUTHORITY,
          isSigner: false,
          isWritable: false,
        },
        { pubkey: CONFIG.PUMP_PROGRAM, isSigner: false, isWritable: false },
        { pubkey: globalVolumeAccumulator, isSigner: false, isWritable: true },
        { pubkey: userVolumeAccumulator, isSigner: false, isWritable: true },
        { pubkey: feeConfig, isSigner: false, isWritable: false },
        { pubkey: CONFIG.PUMP_FEE_PROGRAM, isSigner: false, isWritable: false },
      ],
      data: Buffer.concat([
        DISCRIMINATORS.BUY,
        Buffer.from(new BN(tokenAmount.toString()).toArray("le", 8)),
        Buffer.from(new BN(maxSolCost).toArray("le", 8)),
      ]),
    }),
  );

  tx.recentBlockhash = blockhash;
  tx.feePayer = wallet.publicKey;
  return tx;
}

function buildSellTx(
  wallet: Keypair,
  mint: PublicKey,
  creator: PublicKey,
  tokenAmount: bigint,
  priorityFee: number,
  blockhash: string,
  useDustFees: boolean = false,
  slippageMultiplier: number = 1.0,
  minSolOutputOverride?: number,
): Transaction {
  const tx = new Transaction();

  const computeUnits = useDustFees ? 120000 : CONFIG.COMPUTE_UNITS_SELL;
  const actualPriorityFee = useDustFees ? 15000 : priorityFee;

  tx.add(ComputeBudgetProgram.setComputeUnitLimit({ units: computeUnits }));
  tx.add(
    ComputeBudgetProgram.setComputeUnitPrice({
      microLamports: actualPriorityFee,
    }),
  );

  const [bondingCurve] = PublicKey.findProgramAddressSync(
    [Buffer.from("bonding-curve"), mint.toBuffer()],
    CONFIG.PUMP_PROGRAM,
  );

  const associatedBondingCurve = getAssociatedTokenAddressSync(
    mint,
    bondingCurve,
    true,
  );
  const sellerAta = getAssociatedTokenAddressSync(mint, wallet.publicKey);

  const creatorVault = findCreatorVault(creator);
  const feeConfig = findFeeConfig();

  // Progressive slippage: Accept bigger losses on each retry
  // slippageMultiplier: 0.98 = accept 2% loss (get 98% back), 0.95 = 5% loss, 0.90 = 10% loss
  const fallbackMin = Math.floor(
    CONFIG.BUY_AMOUNT_SOL * LAMPORTS_PER_SOL * 0.3,
  );
  const minSolOutput =
    minSolOutputOverride !== undefined
      ? Math.max(1, Math.floor(minSolOutputOverride))
      : Math.max(1, Math.floor(fallbackMin * slippageMultiplier));

  tx.add(
    new TransactionInstruction({
      programId: CONFIG.PUMP_PROGRAM,
      keys: [
        { pubkey: CONFIG.PUMP_GLOBAL, isSigner: false, isWritable: false },
        {
          pubkey: CONFIG.PUMP_FEE_RECIPIENT,
          isSigner: false,
          isWritable: true,
        },
        { pubkey: mint, isSigner: false, isWritable: false },
        { pubkey: bondingCurve, isSigner: false, isWritable: true },
        { pubkey: associatedBondingCurve, isSigner: false, isWritable: true },
        { pubkey: sellerAta, isSigner: false, isWritable: true },
        { pubkey: wallet.publicKey, isSigner: true, isWritable: true },
        { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
        { pubkey: creatorVault, isSigner: false, isWritable: true },
        { pubkey: TOKEN_PROGRAM_ID, isSigner: false, isWritable: false },
        {
          pubkey: CONFIG.PUMP_EVENT_AUTHORITY,
          isSigner: false,
          isWritable: false,
        },
        { pubkey: CONFIG.PUMP_PROGRAM, isSigner: false, isWritable: false },
        { pubkey: feeConfig, isSigner: false, isWritable: false },
        { pubkey: CONFIG.PUMP_FEE_PROGRAM, isSigner: false, isWritable: false },
      ],
      data: Buffer.concat([
        DISCRIMINATORS.SELL,
        Buffer.from(new BN(tokenAmount.toString()).toArray("le", 8)),
        Buffer.from(new BN(minSolOutput).toArray("le", 8)),
      ]),
    }),
  );

  tx.recentBlockhash = blockhash;
  tx.feePayer = wallet.publicKey;
  return tx;
}

// ============================================================================
// TRANSACTION SIMULATION & VALIDATION
// ============================================================================

async function simulateTransaction(
  connection: Connection,
  transaction: Transaction,
): Promise<{ success: boolean; error?: string; logs?: string[] }> {
  if (!CONFIG.SIMULATE_BEFORE_SEND) {
    return { success: true };
  }

  try {
    const simulation = await connection.simulateTransaction(transaction);

    if (simulation.value.err) {
      return {
        success: false,
        error: JSON.stringify(simulation.value.err),
        logs: simulation.value.logs || [],
      };
    }

    return { success: true, logs: simulation.value.logs || [] };
  } catch (err: any) {
    return {
      success: false,
      error: err.message || String(err),
    };
  }
}

// ============================================================================
// POSITION MANAGEMENT
// ============================================================================

async function findAndSellAllPositions(
  connection: Connection,
  wallet: Keypair,
  tradeLogger: TradeLogger,
) {
  log("INFO", "🔍 Scanning for hung positions from previous runs...");

  try {
    await tradeLogger.syncFromChain();
    const openTrades = tradeLogger.getAllOpenTrades();
    if (openTrades.length === 0) {
      log("INFO", "✅ No hung positions found");
      return;
    }

    log(
      "INFO",
      `📋 Found ${openTrades.length} open token positions on-chain/cache`,
    );

    let positionsSold = 0;
    let positionsSkipped = 0;

    for (const trade of openTrades) {
      const mintStr = trade.mint;
      const mint = new PublicKey(mintStr);
      const ata = getAssociatedTokenAddressSync(mint, wallet.publicKey);

      let balance: bigint;
      try {
        const acc = await connection.getAccountInfo(ata);
        if (!acc || acc.data.length < 72) {
          log(
            "INFO",
            `⚠️  No token account for ${mintStr} - removing cached entry`,
          );
          tradeLogger.logSell(
            mintStr,
            "startup-cleanup",
            0,
            trade.buy_sol || undefined,
            Date.now(),
          );
          positionsSkipped++;
          continue;
        }
        balance = acc.data.readBigUInt64LE(64);
      } catch (err) {
        log("WARN", `Failed to check balance for ${mintStr}: ${err}`);
        positionsSkipped++;
        continue;
      }

      if (balance === BigInt(0)) {
        log("INFO", `⚠️  Zero balance for ${mintStr} - removing cached entry`);
        tradeLogger.logSell(
          mintStr,
          "startup-cleanup",
          0,
          trade.buy_sol || undefined,
          Date.now(),
        );
        positionsSkipped++;
        continue;
      }

      log(
        "INFO",
        `💼 Hung position: ${mintStr} (${balance.toString()} tokens)`,
      );

      let creator: PublicKey;
      if (trade.creator) {
        creator = new PublicKey(trade.creator);
      } else {
        try {
          const [bondingCurve] = PublicKey.findProgramAddressSync(
            [Buffer.from("bonding-curve"), mint.toBuffer()],
            CONFIG.PUMP_PROGRAM,
          );

          const bondingCurveAcc = await connection.getAccountInfo(bondingCurve);
          if (!bondingCurveAcc || bondingCurveAcc.data.length < 81) {
            log("ERROR", `❌ Cannot fetch bonding curve for ${mintStr}`);
            positionsSkipped++;
            continue;
          }

          const creatorOffset = 49;
          creator = new PublicKey(
            Buffer.from(
              bondingCurveAcc.data.subarray(creatorOffset, creatorOffset + 32),
            ),
          );
          log(
            "SUCCESS",
            `✅ Fetched creator from chain: ${creator.toBase58()}`,
          );
        } catch (err) {
          log("ERROR", `❌ Failed to fetch creator for ${mintStr}: ${err}`);
          positionsSkipped++;
          continue;
        }
      }

      if (!getCachedBlockhash()) {
        log(
          "WARN",
          `⚠️  No blockhash available yet - will retry on next startup`,
        );
        positionsSkipped++;
        continue;
      }

      try {
        await executeSell(
          connection,
          wallet,
          mint,
          creator,
          mintStr,
          "startup cleanup",
          tradeLogger,
        );
        positionsSold++;
      } catch (err) {
        log("ERROR", `Failed to sell ${mintStr}: ${err}`);
        positionsSkipped++;
      }
    }

    log(
      "INFO",
      `✅ Startup cleanup complete: ${positionsSold} sold, ${positionsSkipped} skipped`,
    );
  } catch (err) {
    log("ERROR", `Startup position scan failed: ${err}`);
  }
}

async function executeSellWithRetry(
  connection: Connection,
  wallet: Keypair,
  mint: PublicKey,
  creator: PublicKey,
  mintStr: string,
  reason: string,
  tradeLogger: TradeLogger,
  attemptNumber: number = 1,
  maxAttempts: number = 3,
): Promise<boolean> {
  const startTime = Date.now();

  try {
    log(
      "INFO",
      `⏰ Sell attempt ${attemptNumber}/${maxAttempts} for ${mintStr} (${reason})`,
    );
    if (attemptNumber === 1) {
      metrics.totalSells++;
    }

    const ata = getAssociatedTokenAddressSync(mint, wallet.publicKey);

    // Retry fetching account up to 3 times
    let acc: AccountInfo<Buffer> | null = null;
    for (let i = 0; i < 3; i++) {
      acc = await connection.getAccountInfo(ata);
      if (acc) break;
      await new Promise((r) => setTimeout(r, 1000));
    }

    if (!acc) {
      log("ERROR", `❌ No ATA account for ${mintStr}`);
      if (attemptNumber === 1) metrics.failedSells++;
      return false;
    }
    if (acc.data.length < 72) {
      log("ERROR", `❌ ATA data too short: ${acc.data.length}`);
      if (attemptNumber === 1) metrics.failedSells++;
      return false;
    }
    const totalBalance = acc.data.readBigUInt64LE(64);
    if (totalBalance === BigInt(0)) {
      log("ERROR", `❌ Zero balance for ${mintStr}`);
      if (attemptNumber === 1) metrics.failedSells++;
      return false;
    }

    const blockhash = getCachedBlockhash();
    if (!blockhash) {
      log("ERROR", `❌ No blockhash for sell`);
      if (attemptNumber === 1) metrics.failedSells++;
      return false;
    }

    const sellPriorityFee = CONFIG.USE_DUST_SELL
      ? 15000
      : getDynamicPriorityMicroLamports(CONFIG.COMPUTE_UNITS_SELL);
    const sellComputeUnits = CONFIG.USE_DUST_SELL
      ? 120000
      : CONFIG.COMPUTE_UNITS_SELL;
    const priorityLamports = calculatePriorityLamports(
      sellPriorityFee,
      sellComputeUnits,
    );

    // PROGRESSIVELY ACCEPT BIGGER LOSSES with each retry
    // Attempt 1: 0.98 = Accept 2% loss (get 98% back) - OK
    // Attempt 2: 0.95 = Accept 5% loss (get 95% back) - worse but OK
    // Attempt 3: 0.90 = Accept 10% loss (get 90% back) - HORRIBLE but for emergencies
    const slippageMultiplier =
      attemptNumber === 1 ? 0.98 : attemptNumber === 2 ? 0.95 : 0.9;

    let minSolOutputOverride: number | undefined;
    const estimatedProceeds = await estimateSellProceedsLamports(
      connection,
      mint,
      totalBalance,
    );
    if (estimatedProceeds !== null) {
      minSolOutputOverride = Math.max(
        1,
        Math.floor(estimatedProceeds * slippageMultiplier),
      );
      log("INFO", "📉 Sell slippage updated from bonding curve", {
        estimatedSol: (estimatedProceeds / LAMPORTS_PER_SOL).toFixed(6),
        minSol: (minSolOutputOverride / LAMPORTS_PER_SOL).toFixed(6),
        multiplier: slippageMultiplier,
      });
    } else {
      log(
        "WARN",
        "⚠️  Using fallback sell slippage (bonding curve estimate unavailable)",
      );
    }

    const fallbackValue = Math.floor(
      CONFIG.BUY_AMOUNT_SOL * LAMPORTS_PER_SOL * 0.3,
    );
    const expectedValueLamports = Math.max(
      minSolOutputOverride ?? estimatedProceeds ?? fallbackValue,
      1,
    );
    const heliusTipLamports = CONFIG.USE_HELIUS_SENDER
      ? getHeliusTipLamports(CONFIG.HELIUS_TIP_SOL)
      : 0;
    const feeLamports =
      BASE_FEE_LAMPORTS_ESTIMATE + priorityLamports + heliusTipLamports;

    if (CONFIG.EXECUTE) {
      await enforceFeeBudget(
        `sell:${mintStr}`,
        expectedValueLamports,
        feeLamports,
      );
    }

    const sellTx = buildSellTx(
      wallet,
      mint,
      creator,
      totalBalance,
      sellPriorityFee,
      blockhash,
      CONFIG.USE_DUST_SELL,
      slippageMultiplier,
      minSolOutputOverride,
    );
    if (heliusTipLamports > 0) {
      sellTx.add(
        SystemProgram.transfer({
          fromPubkey: wallet.publicKey,
          toPubkey: getRandomJitoTipAccount(),
          lamports: heliusTipLamports,
        }),
      );
    }
    sellTx.sign(wallet);

    // Dry-run mode check
    if (!CONFIG.EXECUTE) {
      log("INFO", `🧪 DRY-RUN: Would send SELL transaction for ${mintStr}`);
      activePositions.delete(mintStr);
      for (const [sig, data] of Array.from(
        confirmedUnsoldTransactions.entries(),
      )) {
        if (data.mint === mintStr) {
          confirmedUnsoldTransactions.delete(sig);
          break;
        }
      }
      return true;
    }

    // Simulate before sending (but don't block on errors - simulation can be wrong)
    const simResult = await simulateTransaction(connection, sellTx);
    if (!simResult.success) {
      const meta: Record<string, unknown> = {};
      if (simResult.error) meta.error = simResult.error;
      if (simResult.logs?.length) {
        meta.logs = simResult.logs.slice(-10);
      }
      log("WARN", `⚠️  Sell simulation failed (proceeding anyway)`, meta);
      // Don't return - simulation errors are often false positives
    }

    let sellSig: string | null = null;
    let sendError: string | undefined;
    try {
      if (CONFIG.USE_HELIUS_SENDER) {
        try {
          sellSig = await sendViaHeliusSender(
            sellTx,
            CONFIG.HELIUS_SENDER_URL,
          );
          log("INFO", `📤 SELL TX SENT via Helius Sender: ${sellSig}`);
        } catch (heliusErr: any) {
          sendError = heliusErr?.message || String(heliusErr);
          log(
            "WARN",
            `Helius Sender failed${sendError ? `: ${sendError}` : ""}`,
            {
              error: heliusErr?.message || heliusErr,
              stack: heliusErr?.stack,
            },
          );
        }
      }

      if (!sellSig) {
        sellSig = await connection.sendRawTransaction(sellTx.serialize(), {
          skipPreflight: true,
          maxRetries: 0,
        });
        if (sendError) {
          log(
            "INFO",
            `📤 SELL TX SENT (RPC fallback after previous error): ${sellSig}`,
          );
        } else {
          log("INFO", `📤 SELL TX SENT: ${sellSig}`);
        }
      }

      log("INFO", `🔗 Solscan: https://solscan.io/tx/${sellSig}`);
    } catch (sendErr: any) {
      log("ERROR", `❌ FAILED TO SEND SELL TX (attempt ${attemptNumber})`, {
        error: sendErr?.message || sendErr,
        stack: sendErr?.stack,
      });

      // Retry logic
      if (attemptNumber < maxAttempts) {
        const backoffMs = attemptNumber * 2000; // 2s, 4s
        log("INFO", `🔄 Retrying sell in ${backoffMs}ms...`);
        await new Promise((r) => setTimeout(r, backoffMs));
        return await executeSellWithRetry(
          connection,
          wallet,
          mint,
          creator,
          mintStr,
          reason,
          tradeLogger,
          attemptNumber + 1,
          maxAttempts,
        );
      }

      if (attemptNumber === 1) metrics.failedSells++;
      tripCircuitBreaker(
        `Sell send failed after ${maxAttempts} attempts: ${sendErr.message}`,
      );
      return false;
    }

    if (!sellSig) {
      const message = sendError
        ? `Sell dispatch failed without signature: ${sendError}`
        : "Sell dispatch failed without signature";
      log("ERROR", `❌ ${message}`);
      if (attemptNumber === 1) {
        metrics.failedSells++;
      }
      return false;
    }

    // Confirm SELL (using fast status check instead of hanging confirmTransaction)
    try {
      // Wait 8 seconds then check status
      await new Promise((r) => setTimeout(r, 8000));

      const status = await connection.getSignatureStatus(sellSig);

      if (!status?.value) {
        log(
          "WARN",
          `⏳ Sell ${sellSig.slice(0, 8)} not confirmed yet (attempt ${attemptNumber}) - assuming pending`,
        );
        // Don't count as failed - it may confirm later
        return false;
      }

      if (status.value.err) {
        const errorStr = JSON.stringify(status.value.err);
        log(
          "ERROR",
          `❌ SELL FAILED (attempt ${attemptNumber}): ${sellSig.slice(0, 8)} - ${errorStr}`,
        );

        // Check for retryable errors (slippage, insufficient liquidity, etc.)
        const isRetryable =
          errorStr.includes("6003") ||
          errorStr.includes("6001") ||
          errorStr.includes("slippage");

        if (isRetryable && attemptNumber < maxAttempts) {
          const backoffMs = attemptNumber * 3000; // 3s, 6s
          log(
            "INFO",
            `🔄 Retryable error detected, retrying sell in ${backoffMs}ms with more slippage...`,
          );
          await new Promise((r) => setTimeout(r, backoffMs));
          return await executeSellWithRetry(
            connection,
            wallet,
            mint,
            creator,
            mintStr,
            reason,
            tradeLogger,
            attemptNumber + 1,
            maxAttempts,
          );
        }

        if (attemptNumber === 1) metrics.failedSells++;
        tripCircuitBreaker(
          `Sell confirmation failed after ${attemptNumber} attempts: ${errorStr}`,
        );
        return false;
      } else if (status.value.confirmationStatus) {
        log(
          "SUCCESS",
          `✅ SELL CONFIRMED (${status.value.confirmationStatus}): ${sellSig}`,
        );
        metrics.successfulSells++;

        const executionTime = Date.now() - startTime;
        metrics.avgSellLatency =
          (metrics.avgSellLatency * (metrics.successfulSells - 1) +
            executionTime) /
          metrics.successfulSells;

        recordSuccess();

        // Remove from tracking
        for (const [sig, data] of Array.from(
          confirmedUnsoldTransactions.entries(),
        )) {
          if (data.mint === mintStr) {
            confirmedUnsoldTransactions.delete(sig);
            break;
          }
        }

        // Fetch transaction meta for PnL
        try {
          const tx = await connection.getTransaction(sellSig, {
            maxSupportedTransactionVersion: 0,
            commitment: "confirmed",
          } as any);
          let sellSol: number | undefined;
          let pnlSol: number | undefined;
          if (tx?.meta?.preBalances && tx?.meta?.postBalances) {
            const diff =
              (tx.meta.postBalances[0] - tx.meta.preBalances[0]) /
              LAMPORTS_PER_SOL;
            sellSol = diff;
            const openTrade = tradeLogger.getOpenTrade(mintStr);
            if (
              openTrade?.buy_sol !== null &&
              openTrade?.buy_sol !== undefined
            ) {
              pnlSol = sellSol + openTrade.buy_sol;
            }
          }
          const sellFeeMetrics: FeeMetrics = {
            signature: sellSig,
            feeLamports,
            expectedValueLamports,
            tipLamports: heliusTipLamports,
            priorityMicroLamports: sellPriorityFee,
            computeUnits: sellComputeUnits,
            slippageBps: Math.round((1 - slippageMultiplier) * 10000),
          };

          tradeLogger.logSell(
            mintStr,
            sellSig,
            sellSol,
            pnlSol,
            Date.now(),
            sellFeeMetrics,
          );
          log(
            "SUCCESS",
            `📊 Trade logged: ${pnlSol ? `PnL ${pnlSol.toFixed(6)} SOL` : "PnL unknown"}`,
          );
        } catch (cacheErr) {
          log("WARN", `Failed to persist sell metadata: ${cacheErr}`);
        }

        // Schedule ATA closing
        setTimeout(async () => {
          try {
            const sellerAta = getAssociatedTokenAddressSync(
              mint,
              wallet.publicKey,
            );
            const ataAccount = await connection.getAccountInfo(sellerAta);
            if (!ataAccount) return;

            if (ataAccount.data.length >= 72) {
              const remainingBalance = ataAccount.data.readBigUInt64LE(64);
              if (remainingBalance > BigInt(0)) return;
            }

            const { blockhash: freshBlockhash } =
              await connection.getLatestBlockhash();
            const closeTx = new Transaction();
            closeTx.add(
              createCloseAccountInstruction(
                sellerAta,
                wallet.publicKey,
                wallet.publicKey,
              ),
            );
            closeTx.recentBlockhash = freshBlockhash;
            closeTx.feePayer = wallet.publicKey;
            closeTx.sign(wallet);

            const closeSig = await connection.sendRawTransaction(
              closeTx.serialize(),
              {
                skipPreflight: false,
                maxRetries: 2,
              },
            );

            const closeResult = await connection.confirmTransaction(
              closeSig,
              "confirmed",
            );
            if (!closeResult?.value?.err) {
              log(
                "SUCCESS",
                `💰 Rent reclaimed: 0.00203928 SOL from ${mintStr}`,
              );
            }
          } catch (closeErr: any) {
            log(
              "WARN",
              `⚠️  Failed to close ATA for ${mintStr}: ${closeErr.message}`,
            );
          }
        }, 3000);

        return true; // Success!
      } else {
        log("WARN", `⚠️  Sell ${sellSig.slice(0, 8)} has unknown status`);
        return false;
      }
    } catch (e: any) {
      log(
        "WARN",
        `Sell confirmation error for ${sellSig} (attempt ${attemptNumber}): ${e.message || e}`,
      );

      // Retry on confirmation errors
      if (attemptNumber < maxAttempts) {
        const backoffMs = attemptNumber * 2000;
        log(
          "INFO",
          `🔄 Retrying sell after confirmation error in ${backoffMs}ms...`,
        );
        await new Promise((r) => setTimeout(r, backoffMs));
        return await executeSellWithRetry(
          connection,
          wallet,
          mint,
          creator,
          mintStr,
          reason,
          tradeLogger,
          attemptNumber + 1,
          maxAttempts,
        );
      }

      if (attemptNumber === 1) metrics.failedSells++;
      return false;
    }
  } catch (e: any) {
    log("ERROR", `❌ Sell error (attempt ${attemptNumber}): ${e.message || e}`);

    // Retry on general errors
    if (attemptNumber < maxAttempts) {
      const backoffMs = attemptNumber * 2000;
      log("INFO", `🔄 Retrying sell after error in ${backoffMs}ms...`);
      await new Promise((r) => setTimeout(r, backoffMs));
      return await executeSellWithRetry(
        connection,
        wallet,
        mint,
        creator,
        mintStr,
        reason,
        tradeLogger,
        attemptNumber + 1,
        maxAttempts,
      );
    }

    if (attemptNumber === 1) metrics.failedSells++;
    tripCircuitBreaker(
      `Sell exception after ${attemptNumber} attempts: ${e.message || e}`,
    );
    return false;
  } finally {
    if (attemptNumber === 1 || attemptNumber === maxAttempts) {
      activePositions.delete(mintStr);
    }
  }
}

// Wrapper function for backward compatibility
async function executeSell(
  connection: Connection,
  wallet: Keypair,
  mint: PublicKey,
  creator: PublicKey,
  mintStr: string,
  reason: string,
  tradeLogger: TradeLogger,
) {
  const position = activePositions.get(mintStr);
  if (position) {
    clearPositionTimers(position);
  }
  await executeSellWithRetry(
    connection,
    wallet,
    mint,
    creator,
    mintStr,
    reason,
    tradeLogger,
  );
}

// ============================================================================
// MAIN BOT LOGIC
// ============================================================================

async function main() {
  const rpcUrl = process.env.SHYFT_RPC_URL!.startsWith("http")
    ? process.env.SHYFT_RPC_URL!
    : `https://${process.env.SHYFT_RPC_URL!}`;
  const connection = new Connection(rpcUrl);
  const wallet = Keypair.fromSecretKey(
    bs58.decode(process.env.WALLET_PRIVATE_KEY!),
  );

  log("INFO", "🚀 Starting TokenSniper v2 with MEV Protection");
  log("INFO", `⚙️  Configuration:`, {
    buyAmount: `${CONFIG.BUY_AMOUNT_SOL} SOL`,
    executeMode: CONFIG.EXECUTE ? "LIVE" : "DRY-RUN",
    heliusSender: CONFIG.USE_HELIUS_SENDER,
    heliusTipSol: CONFIG.HELIUS_TIP_SOL,
    dynamicSlippage: CONFIG.DYNAMIC_SLIPPAGE,
    simulateBeforeSend: CONFIG.SIMULATE_BEFORE_SEND,
  });

  // Initialize trade logger
  const tradeLogger = new TradeLogger(connection, wallet.publicKey);
  await tradeLogger.syncFromChain();
  log("INFO", `📊 Trade logger initialized`);

  try {
    const latestBlockhash = await connection.getLatestBlockhash("finalized");
    setBlockhashForTests(
      latestBlockhash.blockhash,
      latestBlockhash.lastValidBlockHeight,
    );
    startupCleanupInProgress = true;
    await findAndSellAllPositions(connection, wallet, tradeLogger);
    startupCleanupDone = true;
    log("INFO", "✅ Pre-stream cleanup complete");
  } catch (err) {
    log("WARN", `Pre-stream cleanup skipped: ${err}`);
  } finally {
    startupCleanupInProgress = false;
  }

  // Check wallet balance
  const balance = await connection.getBalance(wallet.publicKey);
  const balanceSol = balance / LAMPORTS_PER_SOL;
  log("INFO", `🚀 Wallet: ${wallet.publicKey.toBase58()}`);
  log("INFO", `💰 Balance: ${balanceSol.toFixed(4)} SOL`);

  if (balanceSol < CONFIG.MIN_WALLET_BALANCE_SOL) {
    log(
      "WARN",
      `⚠️  Balance ${balanceSol.toFixed(4)} SOL is below recommended minimum (${CONFIG.MIN_WALLET_BALANCE_SOL} SOL).`,
    );
    log(
      "WARN",
      "⚠️  Continuing in maintenance mode — buys will be skipped until balance recovers.",
    );
  }

  // Start background cache updaters
  await Promise.all([
    startBlockhashCache(connection),
    startPriorityFeeCache(connection),
  ]);

  // Initialize gRPC stream
  const client = new Client(
    process.env.GRPC_URL!,
    process.env.X_TOKEN,
    undefined,
  );
  const stream = await client.subscribe();

  // Health check interval
  setInterval(() => {
    const blockhashAge = blockhashCache
      ? Date.now() - blockhashCache.timestamp
      : -1;
    const feeAge = priorityFeeCache
      ? Date.now() - priorityFeeCache.timestamp
      : -1;

    log("INFO", "💓 Health check", {
      blockhashAge: `${blockhashAge}ms`,
      feeAge: `${feeAge}ms`,
      activePositions: activePositions.size,
      circuitBreakerOpen: circuitBreaker.isOpen,
      metrics: {
        buySuccessRate:
          metrics.totalBuys > 0
            ? ((metrics.successfulBuys / metrics.totalBuys) * 100).toFixed(1) +
              "%"
            : "N/A",
        sellSuccessRate:
          metrics.totalSells > 0
            ? ((metrics.successfulSells / metrics.totalSells) * 100).toFixed(
                1,
              ) + "%"
            : "N/A",
      },
    });
  }, 30000); // Every 30 seconds

  stream.on("data", async (data: any) => {
    try {
      // Capture blockhash from block meta (backup)
      if (data.blockMeta?.blockhash && !blockhashCache) {
        blockhashCache = {
          blockhash: data.blockMeta.blockhash,
          lastValidBlockHeight: 0,
          timestamp: Date.now(),
        };
      }

      // Run startup cleanup once
      if (blockhashCache && !startupCleanupDone && !startupCleanupInProgress) {
        startupCleanupInProgress = true;
        log("INFO", "🔄 Running startup cleanup...");
        findAndSellAllPositions(connection, wallet, tradeLogger)
          .then(() => {
            startupCleanupDone = true;
            startupCleanupInProgress = false;
            log("INFO", "✅ Startup cleanup finished");
          })
          .catch((err) => {
            log("ERROR", `Startup cleanup failed: ${err}`);
            startupCleanupInProgress = false;
            startupCleanupDone = true;
          });
      }

      // Block during startup cleanup
      if (startupCleanupInProgress) {
        return;
      }

      // Check circuit breaker
      if (!checkCircuitBreaker()) {
        return;
      }

      // Detect transactions
      const txn = data.transaction;
      if (txn?.transaction) {
        // CRITICAL: Check if this is OUR buy transaction confirming!
        // Yellowstone provides signature in transaction.transaction.signatures array
        const signatures = txn.transaction.transaction?.signatures;
        const signature =
          signatures && signatures.length > 0
            ? bs58.encode(signatures[0])
            : null;

        // Debug: Log all signatures if we have pending buys
        if (signature && pendingBuys.size > 0) {
          log(
            "DEBUG",
            `Stream sig: ${signature.slice(0, 12)}... (checking ${pendingBuys.size} pending)`,
          );
        }

        if (signature && pendingBuys.has(signature)) {
          const pending = pendingBuys.get(signature)!;
          pendingBuys.delete(signature);

          // Check if transaction succeeded
          const meta = txn.transaction.meta;
          if (meta?.err) {
            log(
              "ERROR",
              `❌ OUR BUY FAILED: ${signature} - ${JSON.stringify(meta.err)}`,
            );
            cancelPositionTracking(
              pending.mintStr,
              signature,
              "stream error",
            );
            metrics.failedBuys++;
            return;
          }

          log(
            "SUCCESS",
            `✅ OUR BUY CONFIRMED via stream: ${signature.slice(0, 8)}...`,
          );
          metrics.successfulBuys++;
          recordSuccess();

          const executionTime = Date.now() - pending.timestamp;
          metrics.avgBuyLatency =
            (metrics.avgBuyLatency * (metrics.successfulBuys - 1) +
              executionTime) /
            metrics.successfulBuys;
          log("INFO", `⚡ Buy confirmed in ${executionTime}ms`);

          confirmedUnsoldTransactions.set(signature, {
            mint: pending.mintStr,
            timestamp: Date.now(),
          });
          const position = activePositions.get(pending.mintStr);
          if (position) {
            position.isConfirmed = true;
            if (position.otherBuysDetected) {
              log(
                "INFO",
                `⚡ Other buys detected while pending – selling ${pending.mintStr} now`,
              );
              clearPositionTimers(position);
              void executeSell(
                connection,
                wallet,
                pending.mint,
                pending.creator,
                pending.mintStr,
                "stream post-confirm other-buys",
                tradeLogger,
              ).catch((err) =>
                log("ERROR", "Async sell after stream confirm failed", {
                  error: err?.message || err,
                }),
              );
            }
          } else {
            trackPosition(
              connection,
              wallet,
              pending.mint,
              pending.creator,
              pending.mintStr,
              signature,
              pending.sellTimeoutMs,
              tradeLogger,
              true,
            );
          }
          return; // Don't process as a new token
        }
      }

      if (txn?.transaction?.meta?.postTokenBalances) {
        const meta = txn.transaction.meta;
        const pumpBalance = meta.postTokenBalances.find(
          (balance: any) =>
            typeof balance?.mint === "string" &&
            balance.mint.toLowerCase().endsWith("pump"),
        );
        const mintStr = pumpBalance?.mint;

        if (mintStr) {
          // Check if we have an active position
          if (activePositions.has(mintStr)) {
            const position = activePositions.get(mintStr)!;
            if (!position.otherBuysDetected) {
              position.otherBuysDetected = true;
              const holdTime = (
                (Date.now() - position.buyTimestamp) /
                1000
              ).toFixed(1);
              if (position.isConfirmed) {
                clearPositionTimers(position);
                log(
                  "INFO",
                  `📈 ACTIVITY on ${mintStr} after ${holdTime}s - SELLING!`,
                );

                // Spawn async (don't block stream)
                executeSell(
                  connection,
                  wallet,
                  position.mint,
                  position.creator,
                  mintStr,
                  `activity after ${holdTime}s`,
                  tradeLogger,
                ).catch((err) =>
                  log("ERROR", "Async sell failed", {
                    error: err?.message || err,
                  }),
                );
              } else {
                log(
                  "INFO",
                  `📈 ACTIVITY on ${mintStr} detected after ${holdTime}s but buy not confirmed yet – deferring sell`,
                );
              }
            }
            return;
          }

          // New token detected
          if (processedTokens.has(mintStr)) {
            return;
          }

          // Rate limiting
          const now = Date.now();
          const timeSinceLastBuy = now - lastBuyTime;

          if (timeSinceLastBuy < BUY_COOLDOWN_MS) {
            return;
          }

          if (unconfirmedTransactions.size >= 2) {
            return;
          }

          if (confirmedUnsoldTransactions.size >= 1) {
            return;
          }

          processedTokens.add(mintStr);
          lastBuyTime = now;

          const mint = new PublicKey(mintStr);
          log("INFO", `🆕 New token detected: ${mintStr}`);
          metrics.totalBuys++;

          const blockhash = getCachedBlockhash();
          if (!blockhash) {
            log("ERROR", "❌ No blockhash");
            metrics.failedBuys++;
            return;
          }

          // Extract creator
          const transaction = txn.transaction.transaction;
          const accountKeys = transaction.message?.accountKeys;
          if (!accountKeys || accountKeys.length === 0) {
            log("ERROR", "❌ No account keys");
            metrics.failedBuys++;
            return;
          }
          const creator = new PublicKey(accountKeys[0]);

          // Execute buy
          const sellTimeoutMs = CONFIG.SELL_TIMEOUT_MS;

          let sig: string | null = null;
          try {
            // Check balance
            const balance = await connection.getBalance(wallet.publicKey);
            const balanceSol = balance / LAMPORTS_PER_SOL;
            const requiredSol = CONFIG.BUY_AMOUNT_SOL + 0.003;

            if (balanceSol < requiredSol) {
              log(
                "ERROR",
                `❌ INSUFFICIENT BALANCE: ${balanceSol.toFixed(4)} SOL`,
              );
              metrics.failedBuys++;
              tripCircuitBreaker(`Low balance: ${balanceSol.toFixed(4)} SOL`);
              return;
            }

            const buyPriorityFee = getDynamicPriorityMicroLamports(
              CONFIG.COMPUTE_UNITS,
            );
            const priorityLamports = calculatePriorityLamports(
              buyPriorityFee,
              CONFIG.COMPUTE_UNITS,
            );
            const heliusTipLamports = CONFIG.USE_HELIUS_SENDER
              ? getHeliusTipLamports(CONFIG.HELIUS_TIP_SOL)
              : 0;
            const feeLamports =
              BASE_FEE_LAMPORTS_ESTIMATE + priorityLamports + heliusTipLamports;
            const buyAmountLamports = Math.floor(
              CONFIG.BUY_AMOUNT_SOL * LAMPORTS_PER_SOL,
            );

            if (CONFIG.EXECUTE) {
              await enforceFeeBudget(
                `buy:${mintStr}`,
                buyAmountLamports,
                feeLamports,
              );
            }

            const buyTx = await buildBuyTx(
              connection,
              wallet,
              mint,
              creator,
              buyPriorityFee,
              blockhash,
            );
            if (heliusTipLamports > 0) {
              buyTx.add(
                SystemProgram.transfer({
                  fromPubkey: wallet.publicKey,
                  toPubkey: getRandomJitoTipAccount(),
                  lamports: heliusTipLamports,
                }),
              );
            }
            buyTx.sign(wallet);

            if (!CONFIG.EXECUTE) {
              log("INFO", `🧪 DRY-RUN: Would buy ${mintStr}`);
              return;
            }

            // Simulate transaction
            const simResult = await simulateTransaction(connection, buyTx);
            if (!simResult.success) {
              const meta: Record<string, unknown> = {};
              if (simResult.error) meta.error = simResult.error;
              if (simResult.logs?.length) {
                meta.logs = simResult.logs.slice(-10);
              }
              log("ERROR", "❌ Buy simulation failed", meta);
              metrics.failedBuys++;
              return;
            }

            let lastError: string | undefined;

            if (CONFIG.USE_HELIUS_SENDER) {
              try {
                sig = await sendViaHeliusSender(
                  buyTx,
                  CONFIG.HELIUS_SENDER_URL,
                );
                log("INFO", `📤 BUY TX SENT via Helius Sender: ${sig}`);
              } catch (heliusErr: any) {
                lastError = heliusErr?.message || String(heliusErr);
                log(
                  "WARN",
                  `Helius Sender failed${lastError ? `: ${lastError}` : ""}`,
                  {
                    error: heliusErr?.message || heliusErr,
                    stack: heliusErr?.stack,
                  },
                );
              }
            }

            if (!sig) {
              sig = await connection.sendRawTransaction(buyTx.serialize(), {
                skipPreflight: true,
                maxRetries: 0,
              });
              if (lastError) {
                log(
                  "INFO",
                  `📤 BUY TX SENT (RPC fallback after previous error): ${sig}`,
                );
              } else {
                log("INFO", `📤 BUY TX SENT (RPC): ${sig}`);
              }
            }

            const signature = sig;
            if (!signature) {
              throw new Error("Failed to obtain transaction signature");
            }
            sig = signature;

            log("INFO", `🔗 Solscan: https://solscan.io/tx/${signature}`);
            trackPosition(
              connection,
              wallet,
              mint,
              creator,
              mintStr,
              signature,
              sellTimeoutMs,
              tradeLogger,
              false,
            );

            let confirmed = false;
            if (CONFIG.EXECUTE) {
              try {
                const confirmation = await connection.confirmTransaction(
                  signature,
                  "confirmed",
                );
                if (confirmation?.value?.err) {
                  log(
                    "ERROR",
                    `❌ BUY FAILED (confirmation): ${signature} - ${JSON.stringify(
                      confirmation.value.err,
                    )}`,
                  );
                  cancelPositionTracking(
                    mintStr,
                    signature,
                    "buy confirmation error",
                  );
                  metrics.failedBuys++;
                  return;
                }
                confirmed = true;
              } catch (confirmErr: any) {
                log(
                  "WARN",
                  `Confirmation error for ${sig}`,
                  {
                    error: confirmErr?.message || confirmErr,
                    stack: confirmErr?.stack,
                  },
                );
              }
            }

            if (confirmed) {
              try {
                const buyFeeMetrics: FeeMetrics = {
                  signature,
                  feeLamports,
                  expectedValueLamports: buyAmountLamports,
                  tipLamports: heliusTipLamports,
                  priorityMicroLamports: buyPriorityFee,
                  computeUnits: CONFIG.COMPUTE_UNITS,
                  slippageBps: DEFAULT_BUY_SLIPPAGE_BPS,
                };
                tradeLogger.logBuy(
                  mintStr,
                  signature,
                  -CONFIG.BUY_AMOUNT_SOL,
                  Date.now(),
                  creator.toBase58(),
                  buyFeeMetrics,
                );
              } catch (dbErr) {
                log("WARN", `Failed to log buy: ${dbErr}`);
              }

              metrics.successfulBuys++;
              recordSuccess();
              confirmedUnsoldTransactions.set(signature, {
                mint: mintStr,
                timestamp: Date.now(),
              });
              const position = activePositions.get(mintStr);
              if (position) {
                position.isConfirmed = true;
                // If other buys happened while pending, trigger sell now
                if (position.otherBuysDetected) {
                  log(
                    "INFO",
                    `⚡ Other buys detected while pending – selling ${mintStr} now`,
                  );
                  clearPositionTimers(position);
                  void executeSell(
                    connection,
                    wallet,
                    mint,
                    creator,
                    mintStr,
                    "post-confirm other-buys",
                    tradeLogger,
                  ).catch((err) =>
                    log("ERROR", `Async sell after confirm failed: ${err}`),
                  );
                }
              } else {
                trackPosition(
                  connection,
                  wallet,
                  mint,
                  creator,
                  mintStr,
                  signature,
                  sellTimeoutMs,
                  tradeLogger,
                  true,
                );
              }
              return;
            }

            // CRITICAL FIX: Don't wait for confirmTransaction - it's unreliable!
            // Instead, add to pendingBuys and let the stream confirm it
            pendingBuys.set(signature, {
              mint,
              mintStr,
              creator,
              signature,
              timestamp: now,
              sellTimeoutMs,
            });

            log(
              "INFO",
              `⏳ Waiting for stream confirmation of ${signature.slice(0, 8)}...`,
            );

            // Fallback: Check transaction status after 10s if stream doesn't catch it
            setTimeout(async () => {
              if (pendingBuys.has(signature)) {
                log(
                  "WARN",
                  `Stream didn't catch ${signature.slice(0, 8)}, checking manually...`,
                );
                try {
                  const status =
                    await connection.getSignatureStatus(signature);
                  if (status?.value?.confirmationStatus) {
                    const pending = pendingBuys.get(signature);
                    pendingBuys.delete(signature);
                    if (!pending) {
                      return;
                    }
                    log(
                      "INFO",
                      `📡 Manual check: ${signature.slice(0, 8)} is ${status.value.confirmationStatus}`,
                    );
                    if (!status.value.err) {
                      // Manually activate the position
                      log(
                        "SUCCESS",
                        `✅ OUR BUY CONFIRMED via manual check: ${signature.slice(0, 8)}...`,
                      );
                      metrics.successfulBuys++;
                      recordSuccess();

                      confirmedUnsoldTransactions.set(signature, {
                        mint: pending.mintStr,
                        timestamp: Date.now(),
                      });
                      const position = activePositions.get(pending.mintStr);
                      if (position) {
                        position.isConfirmed = true;
                        if (position.otherBuysDetected) {
                          log(
                            "INFO",
                            `⚡ Other buys detected while pending – selling ${pending.mintStr} now`,
                          );
                          clearPositionTimers(position);
                          void executeSell(
                            connection,
                            wallet,
                            pending.mint,
                            pending.creator,
                            pending.mintStr,
                            "manual post-confirm other-buys",
                            tradeLogger,
                          ).catch((sellErr) =>
                            log("ERROR", "Async sell after manual confirm failed", {
                              error: sellErr?.message || sellErr,
                            }),
                          );
                        }
                      } else {
                          trackPosition(
                            connection,
                            wallet,
                            pending.mint,
                            pending.creator,
                            pending.mintStr,
                            signature,
                            pending.sellTimeoutMs,
                            tradeLogger,
                            true,
                          );
                        }
                      } else {
                        log(
                          "ERROR",
                          `❌ Manual check: ${signature.slice(0, 8)} failed - ${JSON.stringify(status.value.err)}`,
                        );
                        cancelPositionTracking(
                          pending.mintStr,
                          signature,
                          "manual status failure",
                        );
                        metrics.failedBuys++;
                      }
                    }
                  } catch (err: any) {
                    log(
                      "WARN",
                      `Manual check error for ${signature.slice(0, 8)}`,
                      {
                        error: err?.message || err,
                        stack: err?.stack,
                      },
                    );
                }
              }
            }, 10000);

            // Persist locally + Redis immediately (optimistic)
            try {
              const buyFeeMetrics: FeeMetrics = {
                signature,
                feeLamports,
                expectedValueLamports: buyAmountLamports,
                tipLamports: heliusTipLamports,
                priorityMicroLamports: buyPriorityFee,
                computeUnits: CONFIG.COMPUTE_UNITS,
                slippageBps: DEFAULT_BUY_SLIPPAGE_BPS,
              };
              tradeLogger.logBuy(
                mintStr,
                sig,
                -CONFIG.BUY_AMOUNT_SOL,
                Date.now(),
                creator.toBase58(),
                buyFeeMetrics,
              );
            } catch (dbErr) {
              log("WARN", `Failed to log buy: ${dbErr}`);
            }
          } catch (e: any) {
            log("ERROR", "❌ Buy error", {
              error: e?.message || e,
              stack: e?.stack,
            });
            if (typeof sig === "string" && sig.length > 0) {
              cancelPositionTracking(mintStr, sig, "buy exception");
            }
            metrics.failedBuys++;
            tripCircuitBreaker(`Buy exception: ${e.message}`);
          }
        } else {
          const streamSignatures =
            txn.transaction.transaction?.signatures || [];
          const signaturePrefix =
            streamSignatures.length > 0
              ? bs58.encode(streamSignatures[0]).slice(0, 8)
              : "unknown";
          log(
            "DEBUG",
            `Txn ${signaturePrefix} has no .pump mint (postTokenBalances=${meta.postTokenBalances.length})`,
          );
        }
      }
    } catch (err) {
      log("ERROR", "Stream data error", {
        error: (err as any)?.message || err,
        stack: (err as any)?.stack,
      });
    }
  });

  const req: SubscribeRequest = {
    accounts: {},
    slots: {},
    transactions: {
      pumpfun: {
        vote: false,
        failed: false,
        signature: undefined,
        accountInclude: [CONFIG.PUMP_TOKEN_PROGRAM],
        accountExclude: [],
        accountRequired: [],
      },
    },
    blocks: {},
    blocksMeta: {
      blockmeta: {},
    },
    entry: {},
    accountsDataSlice: [],
    commitment: CommitmentLevel.PROCESSED,
  };

  stream.write(req);

  // Cleanup stale pending buys every 30 seconds
  setInterval(() => {
    const now = Date.now();
    const PENDING_TIMEOUT_MS = 60000; // 60 seconds max wait

    for (const [sig, pending] of pendingBuys.entries()) {
      if (now - pending.timestamp > PENDING_TIMEOUT_MS) {
        log(
          "WARN",
          `⏰ Pending buy ${sig.slice(0, 8)}... timed out after ${PENDING_TIMEOUT_MS}ms - discarding`,
        );
        pendingBuys.delete(sig);
        cancelPositionTracking(pending.mintStr, sig, "pending timeout");
        metrics.failedBuys++;
      }
    }

    if (pendingBuys.size > 0) {
      log(
        "DEBUG",
        `📋 ${pendingBuys.size} pending buys waiting for stream confirmation`,
      );
    }
  }, 30000);

  // Graceful shutdown
  process.on("SIGINT", () => {
    log("INFO", "🛑 Shutting down gracefully...");
    const stats = tradeLogger.getStats();
    tradeLogger.checkpoint();
    tradeLogger.close();
    log("INFO", "📊 Final statistics:", {
      totalTrades: stats.totalTrades,
      winRate: (stats.winRate * 100).toFixed(1) + "%",
      totalPnL: stats.totalPnL.toFixed(6) + " SOL",
      metrics,
    });
    process.exit(0);
  });

  await new Promise(() => {});
}

if (process.env.NODE_ENV !== "test") {
  main().catch(console.error);
}

export const __testHooks = {
  buildBuyTx,
  buildSellTx,
  evaluateBuyReadinessForTest,
  findAndSellAllPositions,
  executeSell,
  setBlockhashForTests,
  resetStateForTests,
};
