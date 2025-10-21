#!/usr/bin/env node
/**
 * SIMPLE 5-SECOND HOLD TEST
 * 
 * - Buys tokens as they're detected (0.02 SOL each)
 * - Sells after 5 seconds
 * - Uses 10k lamports buy fee, minimal sell fee
 * - Runs for 15 minutes
 */

import "dotenv/config";
import Client, { CommitmentLevel } from "@triton-one/yellowstone-grpc";
import { Connection, Keypair, PublicKey, Transaction, SystemProgram, TransactionInstruction, ComputeBudgetProgram, LAMPORTS_PER_SOL } from "@solana/web3.js";
import { TOKEN_PROGRAM_ID, getAssociatedTokenAddressSync, createAssociatedTokenAccountInstruction } from "@solana/spl-token";
import { buildBuyTransaction, buildSellTransaction } from "../packages/transactions/src/pumpfun/builders";
import { readFileSync } from "fs";
import BN from "bn.js";

// ============================================================================
// CONSTANTS & LOCAL PDA DERIVATIONS (ZERO RPC CALLS)
// ============================================================================

const CONFIG = {
  PUMP_PROGRAM: new PublicKey("6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P"),
  PUMP_TOKEN_PROGRAM: "TSLvdd1pWpHVjahSpsvCXUbgwsL3JAcvokwaKt1eokM",
  PUMP_GLOBAL: new PublicKey("4wTV1YmiEkRvAtNtsSGPtUrqRYQMe5SKy2uB4Jjaxnjf"),
  PUMP_FEE_RECIPIENT: new PublicKey("CebN5WGQ4jvEPvsVU4EoHEpgzq1VV7AbicfhtW4xC9iM"),
  PUMP_EVENT_AUTHORITY: new PublicKey("Ce6TQqeHC9p8KetsN6JsjHK7UTZk7nasjjnr7XxXp9F1"),
  PUMP_FEE_PROGRAM: new PublicKey("pfeeUxB6jkeY1Hxd7CsFCAjcbHA9rWtchMGdZ6VojVZ"),
  COMPUTE_UNITS: 250000,
};

const DISCRIMINATORS = {
  BUY: Buffer.from([0x66, 0x06, 0x3d, 0x12, 0x01, 0xda, 0xeb, 0xea]),
  SELL: Buffer.from([0x33, 0xe6, 0x85, 0xa4, 0x01, 0x7f, 0x83, 0xad]),
};

// Jito tip accounts (random selection for load balancing)
const JITO_TIP_ACCOUNTS = [
  "96gYZGLnJYVFmbjzopPSU6QiEV5fGqZNyN9nmNhvrZU5",
  "HFqU5x63VTqvQss8hp11i4wVV8bD44PvwucfZ2bU7gRe",
  "Cw8CFyM9FkoMi7K7Crf6HNQqf4uEMzpKw6QNghXLvLkY",
  "ADaUMid9yfUytqMBgopwjb2DTLSokTSzL1zt6iGPaS49",
  "DfXygSm4jCyNCybVYYK6DwvWqjKee8pbDmJGcLWNDXjh",
  "ADuUkR4vqLUMWXxW9gh6D6L8pMSawimctcNZ5pGwDcEt",
  "DttWaMuVvTiduZRnguLF7jNxTgiMBZ1hyAumKUiL2KRL",
  "3AVi9Tg9Uo68tJfuvoKvqKNWKkC5wPdSSdeBnizKZ6jT",
];

function getRandomJitoTipAccount(): PublicKey {
  return new PublicKey(JITO_TIP_ACCOUNTS[Math.floor(Math.random() * JITO_TIP_ACCOUNTS.length)]);
}

const JITO_TIP_LAMPORTS = 50000; // 10k lamports tip

const GRPC_URL = process.env.GRPC_URL!;
const X_TOKEN = process.env.X_TOKEN!;
const RPC_URL = process.env.SOLANA_RPC_PRIMARY!;
const JITO_URL = "https://ny.mainnet.block-engine.jito.wtf/api/v1/transactions";
const TRADER_PATH = process.env.TRADER_KEYPAIR_PATH || "./keypairs/trader.json";

const keypairData = JSON.parse(readFileSync(TRADER_PATH, "utf-8"));
const trader = Keypair.fromSecretKey(Uint8Array.from(keypairData));
const connection = new Connection(RPC_URL, "processed");

// Config
const TEST_DURATION_MS = 15 * 60 * 1000; // 15 minutes
const BUY_AMOUNT = 0.01; // SOL
const BUY_PRIORITY_FEE = 33333; // microlamports per unit = ~10k lamports total
const SELL_DELAY_MS = 10000; // 3 seconds
const SELL_PRIORITY_FEE = 100; // minimal
const MIN_BALANCE_SOL = 0.03;
const BUY_COOLDOWN_MS = 10000; // 20 seconds between buys
const RECLAIM_EVERY_N_BUYS = 2; // Reclaim ATA rent every 2 buys
const MAX_TOKEN_AGE_MS = 100; // Only buy tokens younger than 500ms

const startTime = Date.now();
const pendingSells: Array<{ mint: PublicKey; creator: PublicKey; buyTime: number; buyTx: string }> = [];
const processedMints = new Set<string>(); // Track mints we've already processed
let tokensDetected = 0;
let buyAttempts = 0;
let buySuccess = 0;
let sellAttempts = 0;
let sellSuccess = 0;
let lastBuyTime = 0;
let completedBuys = 0;

// PNL tracking
let totalBuySpent = 0;
let totalBuyFees = 0;
let totalSellReceived = 0;
let totalSellFees = 0;

// Cached values to avoid RPC calls
let cachedBalance = 0;
let cachedBlockhash: string | null = null;

console.log("🧪 SIMPLE 3-SECOND HOLD TEST");
console.log("============================\n");
console.log(`Wallet: ${trader.publicKey.toBase58()}`);
console.log(`Buy: ${BUY_AMOUNT} SOL via Jito (~10k lamports fee)`);
console.log(`Sell: After 3s via RPC (minimal fee)`);
console.log(`Cooldown: 20s between buys`);
console.log(`Duration: 15 minutes\n`);

/**
 * Reclaim rent from empty ATAs
 */
async function reclaimRent() {
  console.log(`\n💸 Reclaiming rent from empty ATAs...`);
  
  try {
    const { Transaction, SystemProgram } = await import("@solana/web3.js");
    const { createCloseAccountInstruction } = await import("@solana/spl-token");
    
    const tokenAccounts = await connection.getParsedTokenAccountsByOwner(trader.publicKey, {
      programId: TOKEN_PROGRAM_ID,
    });
    
    const emptyATAs = tokenAccounts.value.filter(acc => 
      parseFloat(acc.account.data.parsed.info.tokenAmount.uiAmount) === 0
    );
    
    if (emptyATAs.length === 0) {
      console.log(`   No empty ATAs to close`);
      return;
    }
    
    console.log(`   Closing ${emptyATAs.length} empty ATAs (~${(emptyATAs.length * 0.00203).toFixed(5)} SOL)`);
    
    const tx = new Transaction();
    for (const ata of emptyATAs) {
      tx.add(createCloseAccountInstruction(
        ata.pubkey,
        trader.publicKey,
        trader.publicKey,
      ));
    }
    
    const { blockhash } = await connection.getLatestBlockhash();
    tx.recentBlockhash = blockhash;
    tx.feePayer = trader.publicKey;
    tx.sign(trader);
    
    const sig = await connection.sendRawTransaction(tx.serialize());
    console.log(`   ✅ Reclaimed: ${sig.slice(0, 16)}...`);
  } catch (error) {
    console.log(`   ❌ Reclaim error: ${(error as Error).message}`);
  }
}

/**
 * Buy token
 */
async function buyToken(mintStr: string, creatorStr: string, receivedAt: number) {
  // Deduplication check - don't buy same token twice
  if (processedMints.has(mintStr)) {
    return;
  }
  processedMints.add(mintStr);
  
  tokensDetected++;
  
  const tokenAge = Date.now() - receivedAt;
  
  // Cooldown check - wait 20s between buys
  const now = Date.now();
  const timeSinceLastBuy = now - lastBuyTime;
  if (lastBuyTime > 0 && timeSinceLastBuy < BUY_COOLDOWN_MS) {
    const waitTime = Math.ceil((BUY_COOLDOWN_MS - timeSinceLastBuy) / 1000);
    console.log(`\n⏸️  Cooldown: waiting ${waitTime}s before next buy (token age: ${tokenAge}ms)...`);
    return;
  }
  
  // Use cached balance (updated in background)
  const balanceSOL = cachedBalance;
  
  if (balanceSOL < MIN_BALANCE_SOL) {
    console.log(`\n🛑 Balance too low (${balanceSOL.toFixed(4)} SOL), stopping`);
    process.exit(0);
  }
  
  console.log(`\n🪙 Token #${tokensDetected}: ${mintStr.slice(0, 8)}... (age: ${tokenAge}ms, balance: ${balanceSOL.toFixed(4)} SOL)`);
  console.log(`   Creator: ${creatorStr.slice(0, 8)}...`);
  
  try {
    const mint = new PublicKey(mintStr);
    const creator = new PublicKey(creatorStr);
    buyAttempts++;
    lastBuyTime = now;
    
    const buildStart = Date.now();
    const { transaction } = await buildBuyTransaction({
      connection,
      buyer: trader.publicKey,
      mint,
      creator,
      amountSol: BUY_AMOUNT,
      slippageBps: 500,
      priorityFeeLamports: BUY_PRIORITY_FEE,
      blockhash: cachedBlockhash || undefined, // Use blockhash from stream
    });
    const buildTime = Date.now() - buildStart;
    
    // Add Jito tip to transaction
    const jitoTipAccount = getRandomJitoTipAccount();
    transaction.add(
      SystemProgram.transfer({
        fromPubkey: trader.publicKey,
        toPubkey: jitoTipAccount,
        lamports: JITO_TIP_LAMPORTS,
      })
    );
    
    const signStart = Date.now();
    transaction.sign(trader);
    const signTime = Date.now() - signStart;
    
    const serializeStart = Date.now();
    // Send via Jito for fast inclusion
    const jitoPayload = {
      jsonrpc: "2.0",
      id: 1,
      method: "sendTransaction",
      params: [transaction.serialize().toString("base64"), { encoding: "base64", skipPreflight: true }],
    };
    
    const serializeTime = Date.now() - serializeStart;
    
    const jitoStart = Date.now();
    const jitoRes = await fetch(JITO_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(jitoPayload),
    });
    
    const jitoData = await jitoRes.json();
    if (jitoData.error) throw new Error(`Jito: ${jitoData.error.message}`);
    
    const jitoTime = Date.now() - jitoStart;
    const signature = jitoData.result;
    const sendTime = Date.now() - receivedAt;
    console.log(`   📤 SENT in ${sendTime}ms (build:${buildTime}ms sign:${signTime}ms jito:${jitoTime}ms): ${signature.slice(0, 8)}...`);
    console.log(`   🔗 https://solscan.io/tx/${signature}`);
    
    // Track immediately (don't wait for confirmation)
    buySuccess++;
    completedBuys++;
    totalBuySpent += BUY_AMOUNT;
    totalBuyFees += (BUY_PRIORITY_FEE / 1e9);
    
    // Schedule sell
    pendingSells.push({
      mint,
      creator,
      buyTime: Date.now(),
      buyTx: signature,
    });
    
    // Check confirmation in background (non-blocking!)
    connection.confirmTransaction(signature, "confirmed").then((confirmation) => {
      if (!confirmation || !confirmation.value) {
        console.log(`   ⚠️  ${signature.slice(0, 8)}... no confirmation value`);
        return;
      }
      if (confirmation.value.err) {
        console.log(`   ❌ ${signature.slice(0, 8)}... FAILED: ${JSON.stringify(confirmation.value.err)}`);
      } else {
        console.log(`   ✅ ${signature.slice(0, 8)}... CONFIRMED - selling in 3s`);
      }
    }).catch(e => {
      console.log(`   ⚠️  ${signature.slice(0, 8)}... confirmation error: ${e?.message || JSON.stringify(e)}`);
    });
    
    // Reclaim rent every 2 buys
    if (completedBuys % RECLAIM_EVERY_N_BUYS === 0) {
      reclaimRent().catch(e => console.error(`Reclaim failed: ${e.message}`));
    }
    
  } catch (error) {
    console.log(`   ❌ Error: ${(error as Error).message}`);
  }
}

/**
 * Sell token
 */
async function sellToken(position: { mint: PublicKey; creator: PublicKey; buyTime: number; buyTx: string }) {
  console.log(`\n💰 Selling ${position.mint.toBase58().slice(0, 8)}...`);
  
  try {
    sellAttempts++;
    
    // Get balance
    const tokenAccounts = await connection.getParsedTokenAccountsByOwner(trader.publicKey, {
      programId: TOKEN_PROGRAM_ID,
    });
    
    const tokenAccount = tokenAccounts.value.find(
      acc => acc.account.data.parsed.info.mint === position.mint.toBase58()
    );
    
    if (!tokenAccount) {
      console.log(`   ⏭️  No token account`);
      return;
    }
    
    const balance = parseFloat(tokenAccount.account.data.parsed.info.tokenAmount.uiAmount);
    if (balance === 0) {
      console.log(`   ⏭️  Zero balance`);
      return;
    }
    
    const { transaction } = await buildSellTransaction({
      connection,
      seller: trader.publicKey,
      mint: position.mint,
      creator: position.creator,
      tokenAmount: balance,
      slippageBps: 1000,
      priorityFeeLamports: SELL_PRIORITY_FEE,
    });
    
    transaction.sign(trader);
    const signature = await connection.sendRawTransaction(transaction.serialize(), {
      skipPreflight: false,
    });
    
    console.log(`   📤 Sell TX: ${signature}`);
    console.log(`   🔗 https://solscan.io/tx/${signature}`);
    
    const confirmation = await connection.confirmTransaction(signature, "confirmed");
    
    if (confirmation.value.err) {
      console.log(`   ❌ Sell FAILED: ${JSON.stringify(confirmation.value.err)}`);
      return;
    }
    
    sellSuccess++;
    const holdTime = Math.floor((Date.now() - position.buyTime) / 1000);
    console.log(`   ✅ Sell CONFIRMED ON-CHAIN (held ${holdTime}s)`);
    
    // Track sell revenue (estimate - need to parse tx logs for exact amount)
    // For now, assume we got ~0.008 SOL back on average (0.01 buy with slippage/fees)
    totalSellReceived += balance * 0.0001; // Rough estimate based on token price
    totalSellFees += (SELL_PRIORITY_FEE / 1e9);
    
  } catch (error) {
    console.log(`   ❌ Sell error: ${(error as Error).message}`);
  }
}

/**
 * Process sells in background
 */
async function sellProcessor() {
  while (Date.now() < startTime + TEST_DURATION_MS + 60000) { // Run extra minute to finish sells
    const now = Date.now();
    
    for (let i = pendingSells.length - 1; i >= 0; i--) {
      const position = pendingSells[i];
      if (now - position.buyTime >= SELL_DELAY_MS) {
        await sellToken(position);
        pendingSells.splice(i, 1);
      }
    }
    
    await new Promise(r => setTimeout(r, 1000)); // Check every second
  }
}

/**
 * Handle Geyser stream
 */
async function handleStream(client: Client) {
  const stream = await client.subscribe();
  console.log("✅ Stream connected\n");

  let eventsReceived = 0;
  let tokensFiltered = 0;
  let createInstructionsFound = 0;

  stream.on("error", (error) => {
    console.error("❌ Stream error:", error);
  });

  // Handle data - EXACT logic from working stream_pump_fun_new_minted_tokens example
  stream.on("data", async (data) => {
    eventsReceived++;
    if (eventsReceived % 100 === 0) {
      console.log(`📊 Events: ${eventsReceived}, Detected: ${tokensDetected}`);
    }
    
    const receivedAt = Date.now();
    if (receivedAt > startTime + TEST_DURATION_MS) return;

    try {
      const dataTx = data.transaction.transaction;
      const meta = dataTx?.meta;
      
      // Debug: Log why we're skipping
      if (eventsReceived % 50 === 0) {
        const firstMint = meta?.postTokenBalances?.[0]?.mint;
        console.log(`   Debug: meta=${!!meta}, postBal=${meta?.postTokenBalances?.length || 0}, mint="${firstMint}"`);
      }
      
      if (!meta || !meta.postTokenBalances || meta.postTokenBalances.length === 0) return;

      const mint = meta.postTokenBalances[0].mint;
      if (!mint) {
        console.log(`   ⚠️  Mint is falsy: ${mint}`);
        return;
      }
      
      const message = dataTx.transaction?.message;
      const accountKeys = message?.accountKeys;
      if (!accountKeys || accountKeys.length === 0) {
        if (eventsReceived % 50 === 0) console.log(`   Debug: No accountKeys`);
        return;
      }
      
      const bs58 = await import("bs58");
      const creatorBytes = accountKeys[0];
      const creator = bs58.default.encode(Buffer.from(creatorBytes));
      
      if (message?.recentBlockhash) {
        cachedBlockhash = bs58.default.encode(Buffer.from(message.recentBlockhash));
      }
      
      console.log(`   🎯 Calling buyToken for ${mint.slice(0, 8)}...`);
      buyToken(mint, creator, receivedAt).catch(e => console.error(`Buy failed: ${e.message}`));

    } catch (error) {
      // Silent
    }
  });

  // Subscribe
  const request = {
    accounts: {},
    slots: {},
    transactions: {
      pumpfun: {
        vote: false,
        failed: false,
        signature: undefined,
        accountInclude: ["6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P"], // Main program - gets ALL txs
        accountExclude: [],
        accountRequired: [],
      },
    },
    transactionsStatus: {},
    entry: {},
    blocks: {},
    blocksMeta: {
      blockmeta: {}, // Subscribe to block meta for blockhash
    },
    accountsDataSlice: [],
    ping: undefined,
    commitment: CommitmentLevel.PROCESSED,
  };

  console.log("🔄 Subscribing to Pump.fun TOKEN PROGRAM...");
  console.log(`   Program: ${CONFIG.PUMP_TOKEN_PROGRAM}`);
  
  await new Promise<void>((resolve, reject) => {
    stream.write(request, (err: any) => {
      if (err) {
        console.error("❌ Subscribe failed:", err);
        reject(err);
      } else {
        console.log("✅ Subscribed successfully to TOKEN PROGRAM!");
        console.log("   Waiting for CREATE transactions...");
        resolve();
      }
    });
  });

  // Wait for duration
  await new Promise(r => setTimeout(r, TEST_DURATION_MS));
  stream.end();
  
  console.log("\n⏱️  Test period complete, finishing remaining sells...");
}

/**
 * Background balance updater
 */
async function balanceUpdater() {
  while (Date.now() < startTime + TEST_DURATION_MS + 60000) {
    try {
      const balance = await connection.getBalance(trader.publicKey);
      cachedBalance = balance / 1e9;
    } catch (e) {
      console.error(`Balance update error: ${(e as Error).message}`);
    }
    await new Promise(r => setTimeout(r, 2000)); // Update every 2 seconds
  }
}

/**
 * Main
 */
async function main() {
  console.log("🔄 Checking balance...");
  // Initial balance check
  const balance = await connection.getBalance(trader.publicKey);
  cachedBalance = balance / 1e9;
  console.log(`Starting balance: ${cachedBalance.toFixed(6)} SOL\n`);
  
  console.log("🔄 Connecting to Geyser...");
  const client = new Client(GRPC_URL, X_TOKEN, undefined);

  console.log("🔄 Starting background tasks...");
  // Start background tasks
  const balanceTask = balanceUpdater();
  const sellTask = sellProcessor();

  console.log("🔄 Starting stream...");
  // Run stream for 15 minutes
  await handleStream(client);

  // Wait for background tasks to finish
  await Promise.all([sellTask, balanceTask]);

  // Get final balance for accurate PNL
  const startBalance = await connection.getBalance(trader.publicKey);
  const startBalanceSOL = startBalance / 1e9;
  
  // Print stats
  console.log("\n" + "=".repeat(60));
  console.log("📊 TEST RESULTS - 15 MINUTE SESSION");
  console.log("=".repeat(60));
  console.log(`\n📈 Trading Activity:`);
  console.log(`  Tokens detected: ${tokensDetected}`);
  console.log(`  Buy attempts: ${buyAttempts}`);
  console.log(`  Buy success: ${buySuccess} (${buyAttempts > 0 ? ((buySuccess/buyAttempts)*100).toFixed(1) : 0}%)`);
  console.log(`  Sell attempts: ${sellAttempts}`);
  console.log(`  Sell success: ${sellSuccess} (${sellAttempts > 0 ? ((sellSuccess/sellAttempts)*100).toFixed(1) : 0}%)`);
  console.log(`  Pending sells: ${pendingSells.length}`);
  
  console.log(`\n💰 Profit & Loss:`);
  console.log(`  Total buy spent: ${totalBuySpent.toFixed(6)} SOL`);
  console.log(`  Total buy fees: ${totalBuyFees.toFixed(6)} SOL`);
  console.log(`  Total sell received: ${totalSellReceived.toFixed(6)} SOL (estimated)`);
  console.log(`  Total sell fees: ${totalSellFees.toFixed(6)} SOL`);
  
  const grossPNL = totalSellReceived - totalBuySpent;
  const netPNL = grossPNL - totalBuyFees - totalSellFees;
  
  console.log(`\n📊 Summary:`);
  console.log(`  Gross P&L: ${grossPNL >= 0 ? '+' : ''}${grossPNL.toFixed(6)} SOL`);
  console.log(`  Net P&L: ${netPNL >= 0 ? '+' : ''}${netPNL.toFixed(6)} SOL`);
  console.log(`  Total fees paid: ${(totalBuyFees + totalSellFees).toFixed(6)} SOL`);
  
  console.log(`\n💵 At $200/SOL:`);
  console.log(`  Gross P&L: ${grossPNL >= 0 ? '+' : ''}$${(grossPNL * 200).toFixed(2)}`);
  console.log(`  Net P&L: ${netPNL >= 0 ? '+' : ''}$${(netPNL * 200).toFixed(2)}`);
  console.log(`  Total fees: $${((totalBuyFees + totalSellFees) * 200).toFixed(2)}`);
  
  console.log(`\n💼 Final balance: ${startBalanceSOL.toFixed(6)} SOL`);
  console.log("=".repeat(60));
}

main().catch(console.error);

