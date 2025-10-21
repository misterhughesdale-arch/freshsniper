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
import { Connection, Keypair, PublicKey } from "@solana/web3.js";
import { TOKEN_PROGRAM_ID } from "@solana/spl-token";
import { buildBuyTransaction, buildSellTransaction } from "../packages/transactions/src/pumpfun/builders";
import { readFileSync } from "fs";

const GRPC_URL = process.env.GRPC_URL!;
const X_TOKEN = process.env.X_TOKEN!;
const RPC_URL = process.env.SOLANA_RPC_PRIMARY!;
const JITO_URL = "https://ny.mainnet.block-engine.jito.wtf/api/v1/transactions";
const TRADER_PATH = process.env.TRADER_KEYPAIR_PATH || "./keypairs/trader.json";
const PUMPFUN_PROGRAM = "6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P";

const keypairData = JSON.parse(readFileSync(TRADER_PATH, "utf-8"));
const trader = Keypair.fromSecretKey(Uint8Array.from(keypairData));
const connection = new Connection(RPC_URL, "confirmed");

// Config
const TEST_DURATION_MS = 15 * 60 * 1000; // 15 minutes
const BUY_AMOUNT = 0.01; // SOL
const BUY_PRIORITY_FEE = 33333; // microlamports per unit = ~10k lamports total
const SELL_DELAY_MS = 3000; // 3 seconds
const SELL_PRIORITY_FEE = 100; // minimal
const MIN_BALANCE_SOL = 0.03;
const BUY_COOLDOWN_MS = 20000; // 20 seconds between buys
const RECLAIM_EVERY_N_BUYS = 2; // Reclaim ATA rent every 2 buys
const MAX_TOKEN_AGE_MS = 500; // Only buy tokens younger than 500ms

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
    
    transaction.sign(trader);
    
    // Send via Jito for fast inclusion
    const jitoPayload = {
      jsonrpc: "2.0",
      id: 1,
      method: "sendTransaction",
      params: [transaction.serialize().toString("base64"), { encoding: "base64", skipPreflight: true }],
    };
    
    const jitoRes = await fetch(JITO_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(jitoPayload),
    });
    
    const jitoData = await jitoRes.json();
    if (jitoData.error) throw new Error(`Jito: ${jitoData.error.message}`);
    
    const signature = jitoData.result;
    console.log(`   📤 Buy TX (Jito): ${signature}`);
    console.log(`   🔗 https://solscan.io/tx/${signature}`);
    
    const confirmation = await connection.confirmTransaction(signature, "confirmed");
    
    if (confirmation.value.err) {
      console.log(`   ❌ Buy FAILED: ${JSON.stringify(confirmation.value.err)}`);
      return;
    }
    
    buySuccess++;
    completedBuys++;
    console.log(`   ✅ Buy CONFIRMED ON-CHAIN - selling in 3s`);
    
    // Track buy costs
    totalBuySpent += BUY_AMOUNT;
    totalBuyFees += (BUY_PRIORITY_FEE / 1e9); // Convert microlamports to SOL
    
    // Schedule sell
    pendingSells.push({
      mint,
      creator,
      buyTime: Date.now(),
      buyTx: signature,
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

  // Handle data (exact logic from working example)
  stream.on("data", async (data) => {
    eventsReceived++;
    if (eventsReceived % 100 === 0) {
      console.log(`📊 Events: ${eventsReceived}, Creates: ${createInstructionsFound}, Detected: ${tokensDetected}`);
    }
    
    const receivedAt = Date.now();
    if (receivedAt > startTime + TEST_DURATION_MS) return; // Stop after 15 min

    try {
      // Exact structure from working example
      const dataTx = data.transaction.transaction;
      const meta = dataTx?.meta;
      if (!meta || !meta.postTokenBalances || meta.postTokenBalances.length === 0) return;
      
      // Get first mint (exact logic from working example)
      const mint = meta.postTokenBalances[0].mint;
      if (!mint) return;
      
      const message = dataTx.transaction?.message;
      if (!message || !message.instructions || message.instructions.length === 0) return;
      
      // Find CREATE instruction and get creator from ACCOUNTS (index 7 = user/creator)
      const bs58 = await import("bs58");
      const CREATE_DISCRIMINATOR = Buffer.from([181, 157, 89, 15, 12, 94, 60, 216]);
      let creator: string | null = null;
      
      for (const ix of message.instructions) {
        if (!ix.data || ix.data.length < 8) continue;
        const ixData = Buffer.from(ix.data);
        
        if (ixData.slice(0, 8).equals(CREATE_DISCRIMINATOR)) {
          createInstructionsFound++;
          
          // Get creator from instruction accounts (index 7 = user/creator)
          if (!ix.accounts || ix.accounts.length < 8) {
            console.log(`   ⚠️  CREATE found but not enough accounts: ${ix.accounts?.length || 0}`);
            continue;
          }
          
          const creatorAccountIndex = ix.accounts[7];
          if (!message.accountKeys || message.accountKeys.length <= creatorAccountIndex) {
            console.log(`   ⚠️  Creator account index out of bounds: ${creatorAccountIndex} >= ${message.accountKeys?.length || 0}`);
            continue;
          }
          
          const creatorBytes = message.accountKeys[creatorAccountIndex];
          creator = bs58.default.encode(Buffer.from(creatorBytes));
          console.log(`   ✅ CREATE instruction found! Creator: ${creator.slice(0, 8)}...`);
          break;
        }
      }
      
      if (!creator) return; // No CREATE instruction found

      // Extract blockhash from stream
      if (message?.recentBlockhash) {
        cachedBlockhash = bs58.default.encode(Buffer.from(message.recentBlockhash));
      }

      // Process token
      buyToken(mint, creator, receivedAt).catch(e => console.error(`Buy failed: ${e.message}`));

    } catch (error) {
      // Silent like working example
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
        accountInclude: [PUMPFUN_PROGRAM],
        accountExclude: [],
        accountRequired: [],
      },
    },
    transactionsStatus: {},
    entry: {},
    blocks: {},
    blocksMeta: {},
    accountsDataSlice: [],
    ping: undefined,
    commitment: CommitmentLevel.PROCESSED, // Use PROCESSED for speed like working example
  };

  console.log("🔄 Subscribing to Pump.fun transactions...");
  await new Promise<void>((resolve, reject) => {
    stream.write(request, (err: any) => {
      if (err) {
        console.error("❌ Subscribe failed:", err);
        reject(err);
      } else {
        console.log("✅ Subscribed successfully!");
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

