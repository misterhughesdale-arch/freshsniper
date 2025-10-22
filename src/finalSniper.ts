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
import { TradeLogger } from "./utils/sqliteLogger";

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
  BUY_AMOUNT_SOL: Number(process.env.BUY_AMOUNT_SOL) || 0.003, // Use env var, default 0.006 SOL
  SELL_TIMEOUT_MS: 60000, // 60 seconds - wait for buying activity or max timeout
  SLIPPAGE_BPS: 500,
  COMPUTE_UNITS: 120000, // Align with observed successful txs for buys
  COMPUTE_UNITS_SELL: 80000, // Lower compute units for sells to reduce fees
  EXECUTE: process.env.EXECUTE !== "false", // Dry-run mode if EXECUTE=false
  USE_DUST_SELL: process.env.USE_DUST_SELL === "true", // Use minimal transaction fees (low priority fee)
  USE_HELIUS_SENDER: process.env.USE_HELIUS_SENDER !== "false", // Use Helius Sender for ultra-low latency (default: true)
  JITO_TIP_AMOUNT: Math.max(
    Number(process.env.JITO_TIP_AMOUNT) || 0.001,
    0.001,
  ), // Helius Sender requires ≥0.001 SOL tip
};

// Helius Sender Jito tip accounts
const JITO_TIP_ACCOUNTS = [
  new PublicKey("4ACfpUFoaSD9bfPdeu6DBt89gB6ENTeHBXCAi87NhDEE"),
  new PublicKey("D2L6yPZ2FmmmTKPgzaMKdhu6EWZcTpLy1Vhx8uvZe7NZ"),
  new PublicKey("9bnz4RShgq1hAnLnZbP8kbgBg1kEmcJBYQq3gQbmnSta"),
  new PublicKey("5VY91ws6B2hMmBFRsXkoAAdsPHBJwRfBht4DXox3xkwn"),
  new PublicKey("2nyhqdwKcJZR2vcqCyrYsaPVdAnFoJjiksCXJ7hfEYgD"),
  new PublicKey("2q5pghRs6arqVjRvT5gfgWfWcHWmw1ZuCzphgd5KfWGJ"),
  new PublicKey("wyvPkWjVZz1M8fHQnMMCDTQDbkManefNNhweYk5WkcF"),
  new PublicKey("3KCKozbAaF75qEU33jtzozcJ29yJuaLJTy2jFdzUY8bT"),
  new PublicKey("4vieeGHPYPG2MmyPRcYjdiDmmhN3ww7hsFNap8pVN3Ey"),
  new PublicKey("4TQLFNWK8AovT1gFvda5jfw2oJeRMKEmw7aH6MGBJ3or"),
];

function getRandomJitoTipAccount(): PublicKey {
  return JITO_TIP_ACCOUNTS[Math.floor(Math.random() * JITO_TIP_ACCOUNTS.length)];
}

const DISCRIMINATORS = {
  BUY: Buffer.from([0x66, 0x06, 0x3d, 0x12, 0x01, 0xda, 0xeb, 0xea]),
  SELL: Buffer.from([0x33, 0xe6, 0x85, 0xa4, 0x01, 0x7f, 0x83, 0xad]),
};

// CRITICAL FIX: Track blockhash age to prevent using stale blockhashes
// Solana blockhashes expire after ~60s (150 slots), use 30s threshold for safety
let latestBlockhash: { hash: string; receivedAt: number } | null = null;
const BLOCKHASH_STALE_THRESHOLD_MS = 30000; // 30 seconds

function getValidBlockhash(): string | null {
  if (!latestBlockhash) return null;

  const age = Date.now() - latestBlockhash.receivedAt;
  if (age > BLOCKHASH_STALE_THRESHOLD_MS) {
    log("WARN", `⚠️  Blockhash is stale (${(age / 1000).toFixed(1)}s old) - waiting for fresh one`);
    return null;
  }

  return latestBlockhash.hash;
}

function setBlockhashForTests(blockhash: string) {
  latestBlockhash = {
    hash: blockhash,
    receivedAt: Date.now(),
  };
}

// CRITICAL FIX: Bounded LRU cache instead of unbounded Set
// Prevents memory leak from indefinite growth
const MAX_PROCESSED_TOKENS = 10000;
const processedTokens = new Map<string, number>(); // Map<mint, timestamp>

function addProcessedToken(mint: string) {
  // Add new token with current timestamp
  processedTokens.set(mint, Date.now());

  // If exceeded max size, remove oldest 10%
  if (processedTokens.size > MAX_PROCESSED_TOKENS) {
    const entriesToRemove = Math.floor(MAX_PROCESSED_TOKENS * 0.1);
    const sortedEntries = Array.from(processedTokens.entries())
      .sort((a, b) => a[1] - b[1]) // Sort by timestamp (oldest first)
      .slice(0, entriesToRemove);

    sortedEntries.forEach(([key]) => processedTokens.delete(key));
  }
}

function calculateTokensFromBondingCurveData(
  bondingCurveData: Buffer,
  buySol: number,
): bigint | null {
  if (bondingCurveData.length < 24) {
    return null;
  }

  const virtualTokenReserves = bondingCurveData.readBigUInt64LE(8);
  const virtualSolReserves = bondingCurveData.readBigUInt64LE(16);

  const buyLamports = BigInt(Math.max(1, Math.floor(buySol * LAMPORTS_PER_SOL)));
  if (virtualTokenReserves === 0n || virtualSolReserves === 0n) {
    return null;
  }

  const k = virtualTokenReserves * virtualSolReserves;
  const newSolReserves = virtualSolReserves + buyLamports;
  if (newSolReserves === 0n) {
    return null;
  }

  const newTokenReserves = k / newSolReserves;
  if (virtualTokenReserves <= newTokenReserves) {
    return null;
  }

  const tokensOut = virtualTokenReserves - newTokenReserves;
  if (tokensOut <= 0n) {
    return null;
  }

  // Apply 5% buffer to stay under the real allocation
  const buffered = (tokensOut * 95n) / 100n;
  return buffered > 0n ? buffered : null;
}

const activePositions = new Map<
  string,
  {
    mint: PublicKey;
    creator: PublicKey;
    buyTimestamp: number;
    otherBuysDetected: boolean;
    sellTimeout: NodeJS.Timeout;
  }
>();

// Rate limiter: One buy per 60 seconds with transaction state tracking
let lastBuyTime = 0; // Start at 0 - will be set after first buy or cleanup
const BUY_COOLDOWN_MS = 60000; // 60 seconds between buys

// Transaction state tracking
const unconfirmedTransactions = new Map<string, { mint: string; timestamp: number }>();
const confirmedUnsoldTransactions = new Map<string, { mint: string; timestamp: number }>();

// Flag to track if we've done startup cleanup
let startupCleanupDone = false;
let startupCleanupInProgress = false;

type DetectionSnapshot = {
  shouldBuy: boolean;
  reason: string;
  cooldownRemainingMs: number;
  unconfirmedTransactions: number;
  confirmedUnsold: number;
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

  let reason = "ok";
  let shouldBuy = true;

  if (alreadyProcessed) {
    reason = "processed";
    shouldBuy = false;
  } else if (cooldownRemainingMs > 0) {
    reason = "cooldown";
    shouldBuy = false;
  } else if (unconfirmed > 1) {
    reason = "unconfirmed";
    shouldBuy = false;
  } else if (confirmed > 0) {
    reason = "unsold";
    shouldBuy = false;
  }

  if (shouldBuy && persist) {
    addProcessedToken(mint);
    lastBuyTime = now;
  }

  return {
    shouldBuy,
    reason,
    cooldownRemainingMs,
    unconfirmedTransactions: unconfirmed,
    confirmedUnsold: confirmed,
  };
}

function resetStateForTests() {
  processedTokens.clear();
  activePositions.clear();
  unconfirmedTransactions.clear();
  confirmedUnsoldTransactions.clear();
  lastBuyTime = 0;
  latestBlockhash = null;
  startupCleanupDone = false;
  startupCleanupInProgress = false;
}

function log(_level: string, msg: string) {
  console.log(`[${new Date().toISOString()}] ${msg}`);
}

// Helius Sender: Ultra-low latency transaction submission
async function sendViaHeliusSender(
  transaction: Transaction,
): Promise<string> {
  const serialized = transaction.serialize();
  const base64Tx = Buffer.from(serialized).toString("base64");

  const response = await fetch("https://sender.helius-rpc.com/fast", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: Date.now().toString(),
      method: "sendTransaction",
      params: [
        base64Tx,
        {
          encoding: "base64",
          skipPreflight: true, // Required for Sender
          maxRetries: 0,
        },
      ],
    }),
  });

  const json: any = await response.json();
  if (json.error) {
    throw new Error(`Helius Sender error: ${json.error.message}`);
  }

  return json.result as string;
}

// PDA derivation helpers
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
  // fee_config seed: [b"fee_config", <32-byte constant from IDL>]
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

// Dynamic priority fee (microLamports per CU) using recent fee percentiles
async function getDynamicPriorityFee(
  connection: Connection,
  percentile: 50 | 75 | 95 | 99 = 75,
  options?: { min?: number; max?: number },
): Promise<number> {
  try {
    const fees = await (connection as any).getRecentPrioritizationFees?.();
    if (Array.isArray(fees) && fees.length > 0) {
      const values = fees
        .map((f: any) => Number(f?.prioritizationFee) || 0)
        .filter((v: number) => Number.isFinite(v) && v >= 0)
        .sort((a: number, b: number) => a - b);
      if (values.length === 0) {
        throw new Error('no fee values');
      }
      const idx = Math.min(
        values.length - 1,
        Math.max(0, Math.floor((percentile / 100) * values.length) - 1),
      );
      let fee = values[idx]; // microLamports per CU
      const min = options?.min ?? 6_000; // 6k µLAM/CU
      const max = options?.max ?? 50_000; // 50k µLAM/CU
      fee = Math.min(Math.max(fee, min), max);
      return fee;
    }
  } catch {}
  // Fallback: P75 fee (reasonable middle ground)
  return 10_000; // 19k µLAM/CU (~0.0012 SOL @ 120k CU) - reliable confirmation without overpaying
}

async function buildBuyTx(
  connection: Connection,
  wallet: Keypair,
  mint: PublicKey,
  creator: PublicKey,
  priorityFee: number,
  blockhash: string,
  bondingCurveData?: Buffer,
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

  // CORRECT: associatedBondingCurve is the ATA of the bonding curve
  const associatedBondingCurve = getAssociatedTokenAddressSync(
    mint,
    bondingCurve,
    true,
  );
  const buyerAta = getAssociatedTokenAddressSync(mint, wallet.publicKey);

  // Derive all the new required PDAs
  const creatorVault = findCreatorVault(creator);
  const globalVolumeAccumulator = findGlobalVolumeAccumulator();
  const userVolumeAccumulator = findUserVolumeAccumulator(wallet.publicKey);
  const feeConfig = findFeeConfig();

  // Idempotent ATA create (only if missing)
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

  let tokenAmount: bigint | null = null;
  let curveData = bondingCurveData;

  if (!curveData) {
    try {
      const curveInfo = await connection.getAccountInfo(bondingCurve);
      curveData = curveInfo?.data;
    } catch (err) {
      log("WARN", `Failed to fetch bonding curve for token calc: ${err}`);
    }
  }

  if (curveData) {
    tokenAmount = calculateTokensFromBondingCurveData(
      curveData,
      CONFIG.BUY_AMOUNT_SOL,
    );

    if (tokenAmount !== null) {
      const wholeTokens = tokenAmount / 1_000_000n;
      log(
        "INFO",
        `🎯 Bonding curve quote: ${wholeTokens.toString()} tokens (raw ${tokenAmount.toString()})`,
      );
    }
  }

  if (tokenAmount === null) {
    const tokensPerSol = 35_000_000;
    const requestedTokens = Math.floor(CONFIG.BUY_AMOUNT_SOL * tokensPerSol);
    tokenAmount = BigInt(requestedTokens * 1_000_000);
    log(
      "WARN",
      `Using fallback token estimate: ${requestedTokens.toLocaleString()} tokens`,
    );
  }

  // CRITICAL FIX: Add 5% slippage protection
  // Without slippage, any price movement causes transaction failure
  const SLIPPAGE_BPS_BUY = 500; // 5% slippage (500 basis points)
  const maxSolCost = Math.floor(CONFIG.BUY_AMOUNT_SOL * LAMPORTS_PER_SOL * (1 + SLIPPAGE_BPS_BUY / 10000));

  // All 16 accounts as per IDL
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

  // Add Jito tip for Helius Sender (required for dual routing to validators + Jito)
  if (CONFIG.USE_HELIUS_SENDER) {
    const tipAccount = getRandomJitoTipAccount();
    const tipLamports = Math.floor(CONFIG.JITO_TIP_AMOUNT * LAMPORTS_PER_SOL);
    tx.add(
      SystemProgram.transfer({
        fromPubkey: wallet.publicKey,
        toPubkey: tipAccount,
        lamports: tipLamports,
      }),
    );
  }

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
): Transaction {
  const tx = new Transaction();

  // Use standard compute units for sells
  const computeUnits = useDustFees ? 80000 : CONFIG.COMPUTE_UNITS_SELL;
  // Use P75 priority fee for dust mode (targeting 75th percentile for reliable confirmation)
  // 15000 microLamports per CU = ~0.0012 SOL per 80k CU (reasonable middle ground)
  const actualPriorityFee = useDustFees ? 15000 : priorityFee;

  tx.add(
    ComputeBudgetProgram.setComputeUnitLimit({ units: computeUnits }),
  );
  tx.add(
    ComputeBudgetProgram.setComputeUnitPrice({ microLamports: actualPriorityFee }),
  );

  // Calculate actual priority fee cost:
  // microLamports = CU * (microLamports per CU)
  // lamports = microLamports / 1,000,000
  // SOL = lamports / 1,000,000,000
  const microLamports = computeUnits * actualPriorityFee;
  const lamports = microLamports / 1_000_000;
  const sol = lamports / 1_000_000_000;

  if (useDustFees) {
    log("INFO", `💰 P75 FEES: ${computeUnits} CU @ ${actualPriorityFee} µLAM/CU = ${lamports.toFixed(0)} lamports (${sol.toFixed(6)} SOL)`);
  } else {
    log("INFO", `📊 NORMAL FEES: ${computeUnits} CU @ ${actualPriorityFee} µLAM/CU = ${lamports.toFixed(0)} lamports (${sol.toFixed(6)} SOL)`);
  }

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

  // Derive required PDAs for SELL (only 3 needed)
  const creatorVault = findCreatorVault(creator);
  const feeConfig = findFeeConfig();
  // Note: SELL does NOT use global_volume_accumulator or user_volume_accumulator

  // Calculate minimum SOL output with slippage protection (always protect against loss)
  const minSolOutput = Math.floor(CONFIG.BUY_AMOUNT_SOL * LAMPORTS_PER_SOL * 0.3); // Accept 70% loss max
  log("INFO", `📊 minSolOutput = ${minSolOutput} lamports (${(minSolOutput/LAMPORTS_PER_SOL).toFixed(6)} SOL) - slippage protected`);

  // SELL has 14 accounts (not 16!)
  tx.add(
    new TransactionInstruction({
      programId: CONFIG.PUMP_PROGRAM,
      keys: [
        { pubkey: CONFIG.PUMP_GLOBAL, isSigner: false, isWritable: false },        // 0
        { pubkey: CONFIG.PUMP_FEE_RECIPIENT, isSigner: false, isWritable: true },  // 1
        { pubkey: mint, isSigner: false, isWritable: false },                      // 2
        { pubkey: bondingCurve, isSigner: false, isWritable: true },               // 3
        { pubkey: associatedBondingCurve, isSigner: false, isWritable: true },     // 4
        { pubkey: sellerAta, isSigner: false, isWritable: true },                  // 5
        { pubkey: wallet.publicKey, isSigner: true, isWritable: true },            // 6
        { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },   // 7
        { pubkey: creatorVault, isSigner: false, isWritable: true },               // 8 ← BEFORE token_program!
        { pubkey: TOKEN_PROGRAM_ID, isSigner: false, isWritable: false },          // 9 ← AFTER creator_vault!
        { pubkey: CONFIG.PUMP_EVENT_AUTHORITY, isSigner: false, isWritable: false },// 10
        { pubkey: CONFIG.PUMP_PROGRAM, isSigner: false, isWritable: false },       // 11
        { pubkey: feeConfig, isSigner: false, isWritable: false },                 // 12
        { pubkey: CONFIG.PUMP_FEE_PROGRAM, isSigner: false, isWritable: false },   // 13
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

    log("INFO", `📋 Found ${openTrades.length} open token positions on-chain/cache`);

    let positionsSold = 0;
    let positionsSkipped = 0;

    for (const trade of openTrades) {
      const mintStr = trade.mint;

      // Check if we still hold tokens for this mint
      const mint = new PublicKey(mintStr);
      const ata = getAssociatedTokenAddressSync(mint, wallet.publicKey);

      let balance: bigint;
      try {
        const acc = await connection.getAccountInfo(ata);
        if (!acc || acc.data.length < 72) {
          log("INFO", `⚠️  No token account for ${mintStr} - removing cached entry`);
          tradeLogger.logSell(mintStr, "startup-cleanup", 0, trade.buy_sol || undefined, Date.now());
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
        tradeLogger.logSell(mintStr, "startup-cleanup", 0, trade.buy_sol || undefined, Date.now());
        positionsSkipped++;
        continue;
      }

      log("INFO", `💼 Hung position: ${mintStr} (${balance.toString()} tokens)`);

      // Get creator - either from cached metadata or fetch from bonding curve
      let creator: PublicKey;
      if (trade.creator) {
        creator = new PublicKey(trade.creator);
        log("INFO", `📋 Using creator from cache: ${creator.toBase58()}`);
      } else {
        // Fetch creator from bonding curve account data
        log("INFO", `🔍 No cached creator - fetching from bonding curve...`);
        try {
          const [bondingCurve] = PublicKey.findProgramAddressSync(
            [Buffer.from("bonding-curve"), mint.toBuffer()],
            CONFIG.PUMP_PROGRAM,
          );

          const bondingCurveAcc = await connection.getAccountInfo(bondingCurve);
          if (!bondingCurveAcc || bondingCurveAcc.data.length < 32) {
            log("ERROR", `❌ Cannot fetch bonding curve for ${mintStr}`);
            positionsSkipped++;
            continue;
          }

          // Bonding curve layout: discriminator (8) + virtual_token_reserves (8) + virtual_sol_reserves (8) + real_token_reserves (8) + real_sol_reserves (8) + token_total_supply (8) + complete (1) + creator (32)
          const creatorOffset = 8 + 8 + 8 + 8 + 8 + 8 + 1; // 49 bytes
          if (bondingCurveAcc.data.length < creatorOffset + 32) {
            log("ERROR", `❌ Bonding curve data too short for ${mintStr}`);
            positionsSkipped++;
            continue;
          }

          creator = new PublicKey(Buffer.from(bondingCurveAcc.data.subarray(creatorOffset, creatorOffset + 32)));
          log("SUCCESS", `✅ Fetched creator from chain: ${creator.toBase58()}`);
        } catch (err) {
          log("ERROR", `❌ Failed to fetch creator for ${mintStr}: ${err}`);
          positionsSkipped++;
          continue;
        }
      }

      // Sell this hung position
      log("INFO", `🔄 Attempting to sell hung position ${mintStr}...`);

      // If we don't have a blockhash yet, skip and try again next time
      if (!latestBlockhash) {
        log("WARN", `⚠️  No blockhash available yet - will retry on next startup`);
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

    log("INFO", `✅ Startup cleanup complete: ${positionsSold} sold, ${positionsSkipped} skipped`);
  } catch (err) {
    log("ERROR", `Startup position scan failed: ${err}`);
  }
}

async function executeSell(
  connection: Connection,
  wallet: Keypair,
  mint: PublicKey,
  creator: PublicKey,
  mintStr: string,
  reason: string,
  tradeLogger: TradeLogger,
) {
  try {
    log("INFO", `⏰ Attempting sell for ${mintStr} (${reason})`);
    const ata = getAssociatedTokenAddressSync(mint, wallet.publicKey);

    // Retry fetching account up to 3 times
    let acc: AccountInfo<Buffer> | null = null;
    for (let i = 0; i < 3; i++) {
      acc = await connection.getAccountInfo(ata);
      if (acc) break;
      await new Promise((r) => setTimeout(r, 1000));
    }

    if (!acc) {
      log("ERROR", `❌ No ATA account for ${mintStr} at ${ata.toBase58()}`);
      return;
    }
    if (acc.data.length < 72) {
      log("ERROR", `❌ ATA data too short: ${acc.data.length}`);
      return;
    }
    const totalBalance = acc.data.readBigUInt64LE(64);
    log("INFO", `📊 Token balance: ${totalBalance.toString()}`);
    if (totalBalance === BigInt(0)) {
      log("ERROR", `❌ Zero balance for ${mintStr}`);
      return;
    }

    // Always sell ALL tokens
    const amt = totalBalance;
    log("INFO", `📊 Selling full balance: ${amt.toString()} tokens`);

    // Get valid (non-stale) blockhash
    const blockhash = getValidBlockhash();
    if (!blockhash) {
      log("ERROR", `❌ No valid blockhash for sell`);
      return;
    }

    // Dynamic priority fee for sell (or use minimal if dust mode)
    const sellPriorityFee = CONFIG.USE_DUST_SELL ? 1 : await getDynamicPriorityFee(connection, 75);

    const sellTx = buildSellTx(
      wallet,
      mint,
      creator,
      amt,
      sellPriorityFee,
      blockhash,
      CONFIG.USE_DUST_SELL, // Pass dust flag to use minimal fees
    );
    sellTx.sign(wallet);

    // Dry-run mode check
    if (!CONFIG.EXECUTE) {
      log("INFO", `🧪 DRY-RUN: Would send SELL transaction for ${mintStr}`);
      log("INFO", `🧪 Token amount: ${amt.toString()}`);
      activePositions.delete(mintStr);

      // Remove from confirmed unsold (find by mint)
      for (const [sig, data] of Array.from(confirmedUnsoldTransactions.entries())) {
        if (data.mint === mintStr) {
          confirmedUnsoldTransactions.delete(sig);
          break;
        }
      }
      return;
    }

    let sellSig: string;
    try {
      sellSig = await connection.sendRawTransaction(sellTx.serialize(), {
        skipPreflight: true,
        maxRetries: 0,
      });
      log("INFO", `📤 SELL TX SENT: ${sellSig}`);
      log("INFO", `🔗 Solscan: https://solscan.io/tx/${sellSig}`);
    } catch (sendErr: any) {
      log("ERROR", `❌ FAILED TO SEND SELL TX (dust fees): ${sendErr.message || sendErr}`);

      // If dust mode failed, retry with normal fees
      if (CONFIG.USE_DUST_SELL) {
        log("INFO", `🔄 Retrying with NORMAL fees...`);
        try {
          const normalPriorityFee = await getDynamicPriorityFee(connection, 75);
          const normalSellTx = buildSellTx(
            wallet,
            mint,
            creator,
            amt,
            normalPriorityFee,
            blockhash, // Use the same valid blockhash
            false, // Use normal fees
          );
          normalSellTx.sign(wallet);

          sellSig = await connection.sendRawTransaction(normalSellTx.serialize(), {
            skipPreflight: true,
            maxRetries: 0,
          });
          log("INFO", `📤 SELL TX SENT (normal fees): ${sellSig}`);
          log("INFO", `🔗 Solscan: https://solscan.io/tx/${sellSig}`);
        } catch (retryErr: any) {
          log("ERROR", `❌ FAILED TO SEND SELL TX (normal fees): ${retryErr.message || retryErr}`);
          if (retryErr.logs) {
            log("ERROR", `   Logs: ${JSON.stringify(retryErr.logs)}`);
          }

          // CRITICAL: Keep in tracking - bot will STOP until this is sold
          log("ERROR", `🛑 BOT PAUSED - Must sell ${mintStr} before next buy`);
          log("ERROR", `💡 Position will retry on next bot restart, or sell manually`);
          return;
        }
      } else {
        if (sendErr.logs) {
          log("ERROR", `   Logs: ${JSON.stringify(sendErr.logs)}`);
        }

        // CRITICAL: Keep in tracking - bot will STOP until this is sold
        log("ERROR", `🛑 BOT PAUSED - Must sell ${mintStr} before next buy`);
        log("ERROR", `💡 Position will retry on next bot restart, or sell manually`);
        return;
      }
    }

    // Confirm SELL and persist locally
    try {
      const res = await connection.confirmTransaction(sellSig, "confirmed");
      if (res?.value?.err) {
        log("ERROR", `❌ SELL FAILED: ${sellSig} - ${JSON.stringify(res.value.err)}`);

        // CRITICAL: Keep in tracking - bot will STOP until this is sold
        log("ERROR", `🛑 BOT PAUSED - Must sell ${mintStr} before next buy`);
        log("ERROR", `💡 Position will retry on next bot restart, or sell manually`);
        return; // Exit early on sell failure
      } else {
        log("SUCCESS", `✅ SELL CONFIRMED: ${sellSig}`);

        // Remove from confirmed unsold transactions
        for (const [sig, data] of Array.from(confirmedUnsoldTransactions.entries())) {
          if (data.mint === mintStr) {
            confirmedUnsoldTransactions.delete(sig);
            log("INFO", `📉 Removed ${mintStr} from confirmed unsold positions`);
            break;
          }
        }

        // Fetch transaction meta to compute SOL received and PnL
        try {
          const tx = await connection.getTransaction(sellSig, {
            maxSupportedTransactionVersion: 0,
            commitment: "confirmed",
          } as any);
          let sellSol: number | undefined;
          let pnlSol: number | undefined;
          if (tx?.meta?.preBalances && tx?.meta?.postBalances) {
            const diff = (tx.meta.postBalances[0] - tx.meta.preBalances[0]) / LAMPORTS_PER_SOL;
            sellSol = diff;
            // Try to get buy amount from the open trade
            const openTrade = tradeLogger.getOpenTrade(mintStr);
            if (openTrade?.buy_sol !== null && openTrade?.buy_sol !== undefined) {
              pnlSol = sellSol + openTrade.buy_sol; // buy_sol is negative
            }
          }
          tradeLogger.logSell(mintStr, sellSig, sellSol, pnlSol, Date.now());
          log("SUCCESS", `📊 Trade logged: ${pnlSol ? `PnL ${pnlSol.toFixed(6)} SOL` : "PnL unknown"}`);
        } catch (persistErr) {
          log("WARN", `Failed to persist sell metadata: ${persistErr}`);
        }

        // Schedule ATA closing after a delay to ensure sell has settled
        // Use setTimeout to run as a separate transaction after current flow completes
        setTimeout(async () => {
          try {
            const sellerAta = getAssociatedTokenAddressSync(mint, wallet.publicKey);

            log("INFO", `🔄 Attempting to close ATA for ${mintStr} (separate transaction)...`);

            // Verify the ATA exists and is empty before attempting to close
            const ataAccount = await connection.getAccountInfo(sellerAta);
            if (!ataAccount) {
              log("INFO", `✅ ATA already closed for ${mintStr}`);
              return;
            }

            if (ataAccount.data.length >= 72) {
              const remainingBalance = ataAccount.data.readBigUInt64LE(64);
              if (remainingBalance > BigInt(0)) {
                log("WARN", `⚠️  Cannot close ATA - still has ${remainingBalance.toString()} tokens`);
                return;
              }
            }

            // Get fresh blockhash for close transaction
            const { blockhash: freshBlockhash } = await connection.getLatestBlockhash();

            const closeTx = new Transaction();
            closeTx.add(
              createCloseAccountInstruction(
                sellerAta,
                wallet.publicKey,
                wallet.publicKey,
              )
            );
            closeTx.recentBlockhash = freshBlockhash;
            closeTx.feePayer = wallet.publicKey;
            closeTx.sign(wallet);

            const closeSig = await connection.sendRawTransaction(closeTx.serialize(), {
              skipPreflight: false,
              maxRetries: 2,
            });
            log("INFO", `📤 ATA close tx sent: ${closeSig}`);

            const closeResult = await connection.confirmTransaction(closeSig, "confirmed");
            if (closeResult?.value?.err) {
              log("WARN", `⚠️  ATA close failed: ${JSON.stringify(closeResult.value.err)}`);
            } else {
              log("SUCCESS", `💰 Rent reclaimed: 0.00203928 SOL from ${mintStr}`);
            }
          } catch (closeErr: any) {
            log("WARN", `⚠️  Failed to close ATA for ${mintStr}: ${closeErr.message}`);
            // Don't throw - this is non-critical
          }
        }, 3000); // Wait 3 seconds after sell confirms before attempting close
      }
    } catch (e) {
      log("WARN", `Sell confirmation error for ${sellSig}: ${e}`);

      // CRITICAL: Keep in tracking - bot will STOP until this is sold
      log("ERROR", `🛑 BOT PAUSED - Must sell ${mintStr} before next buy`);
      log("ERROR", `💡 Position will retry on next bot restart, or sell manually`);
    }
  } catch (e) {
    log("ERROR", `❌ Sell error: ${e}`);

    // CRITICAL: Keep in tracking - bot will STOP until this is sold
    log("ERROR", `🛑 BOT PAUSED - Must sell ${mintStr} before next buy`);
    log("ERROR", `💡 Position will retry on next bot restart, or sell manually`);
  } finally {
    activePositions.delete(mintStr);
  }
}

async function main() {
  const rpcUrl = process.env.SHYFT_RPC_URL!.startsWith("http")
    ? process.env.SHYFT_RPC_URL!
    : `https://${process.env.SHYFT_RPC_URL!}`;
  const connection = new Connection(rpcUrl);
  const wallet = Keypair.fromSecretKey(
    bs58.decode(process.env.WALLET_PRIVATE_KEY!),
  );

  // Load configurable sell timeout from env (default 60s)
  const sellTimeoutMs = Number(process.env.SELL_TIMEOUT_MS || CONFIG.SELL_TIMEOUT_MS);
  log("INFO", `⚙️ Sell timeout: ${sellTimeoutMs}ms`);
  log("INFO", `⚙️ Buy amount: ${CONFIG.BUY_AMOUNT_SOL} SOL`);
  log("INFO", `⚙️ Execute mode: ${CONFIG.EXECUTE ? "LIVE" : "DRY-RUN"}`);
  log("INFO", `⚙️ Sell fees: ${CONFIG.USE_DUST_SELL ? "P75 TARGET (80k CU @ 15000 µLAM/CU = 1200 lamports ≈ 0.0012 SOL)" : "NORMAL (80k CU @ dynamic fee ≈ 0.004 SOL)"}`);
  log("INFO", `⚙️ Helius Sender: ${CONFIG.USE_HELIUS_SENDER ? `ENABLED (Jito tip: ${CONFIG.JITO_TIP_AMOUNT} SOL)` : "DISABLED"}`);

  // Initialize SQLite trade logger
  const tradeLogger = new TradeLogger(connection, wallet.publicKey);
  await tradeLogger.syncFromChain();
  log("INFO", `📊 Trade logger initialized`);

  try {
    startupCleanupInProgress = true;
    const latest = await connection.getLatestBlockhash("finalized");
    setBlockhashForTests(latest.blockhash);
    await findAndSellAllPositions(connection, wallet, tradeLogger);
    startupCleanupDone = true;
    log("INFO", "✅ Pre-stream cleanup complete");
  } catch (err) {
    log("WARN", `Pre-stream cleanup skipped: ${err}`);
  } finally {
    startupCleanupInProgress = false;
  }

  // Check and display wallet balance
  const balance = await connection.getBalance(wallet.publicKey);
  const balanceSol = balance / LAMPORTS_PER_SOL;
  log("INFO", `🚀 Wallet: ${wallet.publicKey.toBase58()}`);
  log("INFO", `💰 Balance: ${balanceSol.toFixed(4)} SOL`);
  
  const requiredSol = CONFIG.BUY_AMOUNT_SOL + 0.005;
  if (balanceSol < requiredSol) {
    log("WARN", `⚠️  WARNING: Low balance! Need at least ${requiredSol.toFixed(4)} SOL per trade`);
    log("WARN", `    Current balance may be insufficient for trading`);
  }

  const client = new Client(
    process.env.GRPC_URL!,
    process.env.X_TOKEN,
    undefined,
  );
  const stream = await client.subscribe();

  stream.on("data", async (data: any) => {
    try {
      // Handle account updates (bonding curve data)
      if (data.account) {
        const accountData = data.account;
        const accountPubkey = accountData.account?.pubkey;
        const accountDataBytes = accountData.account?.data;

        if (accountPubkey && accountDataBytes) {
          // Parse bonding curve data slice
          try {
            const dataBuffer = Buffer.from(accountDataBytes);
            // Offset 8: discriminator (8 bytes)
            // Offset 8-16: virtual_token_reserves (u64)
            // Offset 16-24: virtual_sol_reserves (u64)
            // Offset 24-32: real_token_reserves (u64)
            // Offset 32-40: real_sol_reserves (u64)

            if (dataBuffer.length >= 40) {
              const virtualTokenReserves = dataBuffer.readBigUInt64LE(8);
              const virtualSolReserves = dataBuffer.readBigUInt64LE(16);
              const realTokenReserves = dataBuffer.readBigUInt64LE(24);
              const realSolReserves = dataBuffer.readBigUInt64LE(32);

              log("DEBUG", `🔍 Bonding Curve Update: ${accountPubkey}`);
              log("DEBUG", `   vTokens: ${virtualTokenReserves}, vSOL: ${virtualSolReserves}`);
              log("DEBUG", `   rTokens: ${realTokenReserves}, rSOL: ${realSolReserves}`);
            }
          } catch (parseErr) {
            // Silently skip parse errors
          }
        }
      }

      // Capture blockhash with timestamp
      if (data.blockMeta?.blockhash) {
        latestBlockhash = {
          hash: data.blockMeta.blockhash,
          receivedAt: Date.now(),
        };

        // Run startup cleanup once we have a blockhash
        if (!startupCleanupDone && !startupCleanupInProgress) {
          startupCleanupInProgress = true;
          log("INFO", "🔄 Blockhash received - running startup cleanup...");
          // Run cleanup and wait for it to complete
          findAndSellAllPositions(connection, wallet, tradeLogger)
            .then(() => {
              startupCleanupDone = true;
              startupCleanupInProgress = false;
              log("INFO", "✅ Startup cleanup finished - ready to trade");
            })
            .catch((err) => {
              log("ERROR", `Startup cleanup failed: ${err}`);
              startupCleanupInProgress = false;
              startupCleanupDone = true; // Mark as done even if failed to avoid retry loop
            });
        }
      }

      // Block new trades until startup cleanup is complete
      if (startupCleanupInProgress) {
        return; // Skip all trading logic until cleanup finishes
      }

      // Detect new pump tokens and subsequent buys
      const txn = data.transaction;
      if (txn?.transaction?.meta?.postTokenBalances) {
        const meta = txn.transaction.meta;
        const mintStr = meta.postTokenBalances[0]?.mint;

        if (mintStr && mintStr.endsWith("pump")) {
          // Check if this is a buy transaction
          const preBalances = meta.preBalances || [];
          const postBalances = meta.postBalances || [];
          const solSpent =
            (preBalances[0] - postBalances[0]) / LAMPORTS_PER_SOL;

          // Check if we already have a position in this token
          if (activePositions.has(mintStr)) {
            // This is ANY transaction on our token - likely a buy - trigger sell immediately
            const position = activePositions.get(mintStr)!;
            if (!position.otherBuysDetected) {
              position.otherBuysDetected = true;
              clearTimeout(position.sellTimeout);
              const holdTime = ((Date.now() - position.buyTimestamp) / 1000).toFixed(1);
              log(
                "INFO",
                `📈 ACTIVITY DETECTED on ${mintStr} after ${holdTime}s (${solSpent.toFixed(4)} SOL) - SELLING NOW!`,
              );
              await executeSell(
                connection,
                wallet,
                position.mint,
                position.creator,
                mintStr,
                `activity after ${holdTime}s`,
                tradeLogger,
              );
            }
            return;
          }

          // This is a new token creation - buy immediately
          if (processedTokens.has(mintStr)) {
            // Already attempted to trade this token
            return;
          }

          // Advanced rate limiting based on transaction states
          const now = Date.now();
          const timeSinceLastBuy = now - lastBuyTime;
          const unconfirmedCount = unconfirmedTransactions.size;
          const confirmedUnsoldCount = confirmedUnsoldTransactions.size;

          log("INFO", `📊 Rate limit check: cooldown=${(timeSinceLastBuy/1000).toFixed(1)}s/${(BUY_COOLDOWN_MS/1000).toFixed(0)}s, unconfirmed=${unconfirmedCount}/1, unsold=${confirmedUnsoldCount}/0`);

          // Rule 1: Maximum 60 seconds between buys
          if (timeSinceLastBuy < BUY_COOLDOWN_MS) {
            const waitTime = BUY_COOLDOWN_MS - timeSinceLastBuy;
            log("INFO", `⏸️  Rate limit BLOCK: ${(waitTime / 1000).toFixed(1)}s cooldown remaining`);
            return;
          }

          // Rule 2: Maximum 1 unconfirmed transaction at a time
          // Prevents sending too many txs before confirmations
          const MAX_UNCONFIRMED = 1;
          if (unconfirmedCount > MAX_UNCONFIRMED) {
            log("INFO", `⏸️  Rate limit BLOCK: ${unconfirmedCount} unconfirmed transactions (max ${MAX_UNCONFIRMED})`);
            return;
          }

          // Rule 3: Maximum 0 confirmed but unsold positions
          // Must sell existing position before buying new one
          const MAX_UNSOLD = 0;
          if (confirmedUnsoldCount > MAX_UNSOLD) {
            log("INFO", `⏸️  Rate limit BLOCK: ${confirmedUnsoldCount} confirmed unsold positions (max ${MAX_UNSOLD})`);
            return;
          }

          log("INFO", `✅ Rate limit PASSED - proceeding with buy`);

          // Mark this token as processed (using LRU cache)
          addProcessedToken(mintStr);
          lastBuyTime = now; // Set cooldown timer
          
          const mint = new PublicKey(mintStr);
          log("INFO", `🆕 New token detected: ${mintStr} - processing...`);

          // Get valid (non-stale) blockhash
          const blockhash = getValidBlockhash();
          if (!blockhash) {
            log("ERROR", "❌ No valid blockhash");
            return;
          }

          // Fetch creator from bonding curve account data
          const [bondingCurve] = PublicKey.findProgramAddressSync(
            [Buffer.from("bonding-curve"), mint.toBuffer()],
            CONFIG.PUMP_PROGRAM,
          );

          let creator: PublicKey;
          let bondingCurveInfo: AccountInfo<Buffer> | null = null;
          try {
            bondingCurveInfo = await connection.getAccountInfo(bondingCurve);
            if (!bondingCurveInfo) {
              log("ERROR", "❌ No bonding curve account");
              return;
            }
            // Creator is at offset 49 in bonding curve data (8+8+8+8+8+8+1)
            const creatorBytes = bondingCurveInfo.data.slice(49, 49 + 32);
            creator = new PublicKey(creatorBytes);
          } catch (err) {
            log("ERROR", `❌ Failed to fetch creator: ${err}`);
            return;
          }

          // BUY IMMEDIATELY ON CREATION
          try {
            // Check wallet balance before attempting buy
            const balance = await connection.getBalance(wallet.publicKey);
            const balanceSol = balance / LAMPORTS_PER_SOL;
            const requiredSol = CONFIG.BUY_AMOUNT_SOL + 0.003; // buy + fees

            if (balanceSol < requiredSol) {
              log("ERROR", `❌ INSUFFICIENT BALANCE: Need ${requiredSol.toFixed(4)} SOL, have ${balanceSol.toFixed(4)} SOL`);
              log("ERROR", `💸 Please fund wallet: ${wallet.publicKey.toBase58()}`);
              return;
            }

            // Dynamic priority fee for buy (P95 for competitive advantage)
            const buyPriorityFee = await getDynamicPriorityFee(connection, 95);
            const buyTx = await buildBuyTx(
              connection,
              wallet,
              mint,
              creator,
              buyPriorityFee,
              blockhash,
              bondingCurveInfo?.data,
            );
            buyTx.sign(wallet);

            let sig: string;

            // Dry-run mode check
            if (!CONFIG.EXECUTE) {
              log("INFO", `🧪 DRY-RUN: Would send BUY transaction for ${mintStr}`);
              log("INFO", `🧪 Amount: ${CONFIG.BUY_AMOUNT_SOL} SOL, Priority Fee: ${buyPriorityFee} µLAM/CU`);
              return;
            }

            try {
              // Use Helius Sender for ultra-low latency dual routing (validators + Jito)
              if (CONFIG.USE_HELIUS_SENDER) {
                sig = await sendViaHeliusSender(buyTx);
                log("INFO", `📤 BUY TX SENT (Helius Sender): ${sig}`);
              } else {
                sig = await connection.sendRawTransaction(buyTx.serialize(), {
                  skipPreflight: true,
                  maxRetries: 0,
                });
                log("INFO", `📤 BUY TX SENT: ${sig}`);
              }
              log("INFO", `🔗 Solscan: https://solscan.io/tx/${sig}`);

              // Track as unconfirmed transaction
              unconfirmedTransactions.set(sig, { mint: mintStr, timestamp: now });
            } catch (sendErr: any) {
              log("ERROR", `❌ FAILED TO SEND BUY TX: ${sendErr.message || sendErr}`);
              if (sendErr.logs) {
                log("ERROR", `   Logs: ${JSON.stringify(sendErr.logs)}`);
              }
              return;
            }

            // Confirm BUY and persist locally
            try {
              const res = await connection.confirmTransaction(sig, "confirmed");

              // Remove from unconfirmed transactions
              unconfirmedTransactions.delete(sig);

              if (res?.value?.err) {
                log("ERROR", `❌ BUY FAILED: ${sig} - ${JSON.stringify(res.value.err)}`);
                return; // Don't track failed positions
              } else {
                log("SUCCESS", `✅ BUY CONFIRMED: ${sig}`);

                // Add to confirmed unsold transactions
                confirmedUnsoldTransactions.set(sig, { mint: mintStr, timestamp: now });

                // Fetch transaction meta to compute SOL spent
                try {
                  const tx = await connection.getTransaction(sig, {
                    maxSupportedTransactionVersion: 0,
                    commitment: "confirmed",
                  } as any);
                  let buySol: number | undefined;
                  if (tx?.meta?.preBalances && tx?.meta?.postBalances) {
                    const diff = (tx.meta.preBalances[0] - tx.meta.postBalances[0]) / LAMPORTS_PER_SOL;
                    buySol = -Math.abs(diff); // Store as negative (spent)
                  }
                  tradeLogger.logBuy(mintStr, sig, buySol, Date.now(), creator.toBase58());
                  log("SUCCESS", `📊 Buy logged: ${buySol ? `${buySol.toFixed(6)} SOL` : "unknown SOL"}`);
                } catch (persistErr) {
                  log("WARN", `Failed to log buy: ${persistErr}`);
                }

                // ONLY TRACK POSITION AFTER SUCCESSFUL CONFIRMATION
                // Set up timeout to sell after configured duration if no other buys
                const sellTimeout = setTimeout(async () => {
                  const position = activePositions.get(mintStr);
                  if (position && !position.otherBuysDetected) {
                    log("INFO", `⏰ ${sellTimeoutMs}ms timeout - no other buys on ${mintStr}`);
                    await executeSell(
                      connection,
                      wallet,
                      mint,
                      creator,
                      mintStr,
                      `${sellTimeoutMs}ms timeout`,
                      tradeLogger,
                    );
                  }
                }, sellTimeoutMs);

                // Track this position ONLY after successful buy
                activePositions.set(mintStr, {
                  mint,
                  creator,
                  buyTimestamp: Date.now(),
                  otherBuysDetected: false,
                  sellTimeout,
                });
              }
            } catch (e) {
              log("ERROR", `Buy confirmation error for ${sig}: ${e}`);
              // Remove from unconfirmed on error
              unconfirmedTransactions.delete(sig);
              return; // Don't track positions with confirmation errors
            }
          } catch (e) {
            log("ERROR", `❌ Buy: ${e}`);
          }
        }
      }
    } catch (err) {
      log("ERROR", `Stream data error: ${err}`);
    }
  });

  const req: SubscribeRequest = {
    accounts: {
      // Subscribe to bonding curve account updates with data slices
      bondingCurves: {
        owner: [CONFIG.PUMP_PROGRAM.toBase58()],
        account: [],
        filters: [
          // Filter for bonding curve accounts (discriminator check)
          {
            memcmp: {
              offset: "0", // Discriminator at offset 0
              bytes: new Uint8Array(Buffer.from([0x01])), // Bonding curve discriminator
            },
          },
        ],
      },
    },
    slots: {},
    transactions: {
      pumpfun: {
        vote: false,
        failed: false,
        signature: undefined,
        accountInclude: [],
        accountExclude: [],
        accountRequired: [],
      },
    },
    blocks: {},
    blocksMeta: {
      blockmeta: {},
    },
    entry: {},
    accountsDataSlice: [
      // Request specific data slices from accounts to reduce bandwidth
      {
        offset: "0",
        length: "100", // Get first 100 bytes (includes discriminator + key data)
      },
    ],
    commitment: CommitmentLevel.PROCESSED,
  };

  stream.write(req);
  await new Promise(() => {});
}

if (process.env.NODE_ENV !== "test") {
  main().catch(console.error);
}

export const __testHooks = {
  buildBuyTx,
  buildSellTx,
  calculateTokensFromBondingCurveData,
  evaluateBuyReadinessForTest,
  findAndSellAllPositions,
  executeSell,
  setBlockhashForTests,
  resetStateForTests,
};
