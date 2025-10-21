#!/usr/bin/env node
/**
 * FULL SNIPER - Complete Pipeline with Jito Sending
 * 
 * ⚠️ WARNING: This script sends REAL transactions and SPENDS SOL!
 * 
 * Pipeline:
 * 1. Geyser Stream: Detects new Pump.fun tokens via Yellowstone gRPC
 * 2. Build: Constructs buy transaction with priority fees
 * 3. Simulate: Runs preflight check via RPC
 * 4. Send: Submits to Jito Block Engine with tip
 * 5. Confirm: Tracks transaction confirmation
 * 
 * Configuration:
 * - All settings from config/default.toml + .env
 * - Buy amount: config.strategy.buy_amount_sol
 * - Slippage: config.strategy.max_slippage_bps
 * - Priority fee: config.jito.priority_fee_lamports
 * 
 * Usage: pnpm dev:full
 * 
 * Safety:
 * - Start with small amounts (0.001 SOL)
 * - Test with dedicated wallet
 * - Monitor success rates
 */

import "dotenv/config";
import Client, { CommitmentLevel } from "@triton-one/yellowstone-grpc";
import { 
  Connection, 
  Keypair, 
  PublicKey, 
  Transaction,
  SystemProgram,
} from "@solana/web3.js";
import { readFileSync } from "fs";
import { loadConfig } from "../packages/config/src/index";
import { buildBuyTransaction } from "../packages/transactions/src/pumpfun/builders";

const PUMPFUN_PROGRAM = "6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P";

// Load config from TOML files with env var interpolation
const config = loadConfig();

// Load trader keypair
let trader: Keypair;
try {
  const keypairData = JSON.parse(readFileSync(config.wallets.trader_keypair_path, "utf-8"));
  trader = Keypair.fromSecretKey(Uint8Array.from(keypairData));
  console.log(`✅ Trader: ${trader.publicKey.toBase58()}`);
} catch (e) {
  console.error("❌ Failed to load trader keypair from:", config.wallets.trader_keypair_path);
  console.error(e);
  process.exit(1);
}

// RPC connection
const connection = new Connection(config.rpc.primary_url, config.rpc.commitment as any);

// Metrics
const metrics = {
  tokensDetected: 0,
  txBuilt: 0,
  txSimulated: 0,
  simSuccess: 0,
  simFailed: 0,
  txSent: 0,
  txConfirmed: 0,
  txFailed: 0,
  startTime: Date.now(),
};

/**
 * Send transaction via Jito Block Engine
 */
async function sendViaJito(transaction: Transaction): Promise<string> {
  const sendStart = Date.now();
  
  try {
    // Serialize transaction to base64
    const serialized = transaction.serialize({
      requireAllSignatures: false,
      verifySignatures: false,
    });
    const base64Tx = serialized.toString('base64');
    
    // Send to Jito Block Engine
    const response = await fetch(config.jito.block_engine_url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'sendTransaction',
        params: [
          base64Tx,
          {
            encoding: 'base64',
          }
        ]
      })
    });
    
    const result = await response.json();
    const sendTime = Date.now() - sendStart;
    
    if (result.error) {
      throw new Error(result.error.message || JSON.stringify(result.error));
    }
    
    const signature = result.result;
    metrics.txSent++;
    
    console.log(`      ✅ Sent via Jito: ${signature} (${sendTime}ms)`);
    return signature;
    
  } catch (error) {
    metrics.txFailed++;
    throw error;
  }
}

/**
 * Process detected token
 */
async function processToken(mint: string, owner: string, receivedAt: number) {
  const mintPubkey = new PublicKey(mint);
  
  metrics.tokensDetected++;
  console.log(`\n🪙 TOKEN #${metrics.tokensDetected} - ${mint}`);
  console.log(`   Owner: ${owner}`);
  
  try {
    // 1. BUILD TRANSACTION
    const buildStart = Date.now();
    const { transaction } = await buildBuyTransaction({
      connection,
      buyer: trader.publicKey,
      mint: mintPubkey,
      amountSol: config.strategy.buy_amount_sol,
      slippageBps: config.strategy.max_slippage_bps,
      priorityFeeLamports: config.jito.priority_fee_lamports,
    });
    
    // Add Jito tip
    const tipInstruction = SystemProgram.transfer({
      fromPubkey: trader.publicKey,
      toPubkey: new PublicKey(config.jito.tip_account_pubkey),
      lamports: config.jito.priority_fee_lamports, // Use priority fee as tip
    });
    transaction.add(tipInstruction);
    
    const buildTime = Date.now() - buildStart;
    metrics.txBuilt++;
    console.log(`   ⚙️  Built: ${buildTime}ms | Tip: ${config.jito.priority_fee_lamports} lamports`);
    
    // 2. SIMULATE
    const simStart = Date.now();
    const simulation = await connection.simulateTransaction(transaction);
    const simTime = Date.now() - simStart;
    metrics.txSimulated++;
    
    if (simulation.value.err) {
      metrics.simFailed++;
      console.log(`   ❌ Sim failed: ${JSON.stringify(simulation.value.err)}`);
      return;
    }
    
    metrics.simSuccess++;
    console.log(`   ✅ Sim OK: ${simTime}ms | Units: ${simulation.value.unitsConsumed}`);
    
    // 3. SIGN
    transaction.sign(trader);
    
    // 4. SEND VIA JITO
    const signature = await sendViaJito(transaction);
    
    // 5. TRACK (don't wait for confirmation, keep going)
    const totalLatency = Date.now() - receivedAt;
    console.log(`   📊 Total: ${totalLatency}ms | Sig: ${signature.substring(0, 20)}...`);
    
    // Async confirmation check
    confirmTransaction(signature, mint).catch(e => 
      console.log(`   ⚠️  Confirmation check failed: ${e.message}`)
    );
    
  } catch (error) {
    console.log(`   💥 Error: ${(error as Error).message}`);
  }
}

/**
 * Check transaction confirmation (async, non-blocking)
 */
async function confirmTransaction(signature: string, mint: string) {
  try {
    const confirmation = await connection.confirmTransaction(signature, 'confirmed');
    if (confirmation.value.err) {
      metrics.txFailed++;
      console.log(`   ❌ TX Failed: ${mint} - ${signature.substring(0, 20)}...`);
    } else {
      metrics.txConfirmed++;
      console.log(`   🎉 CONFIRMED: ${mint} - ${signature.substring(0, 20)}...`);
    }
  } catch (error) {
    console.log(`   ⚠️  Confirm error for ${mint}: ${(error as Error).message}`);
  }
}

/**
 * Handle Geyser stream
 */
async function handleStream(client: Client, args: any) {
  const stream = await client.subscribe();
  console.log("✅ Stream connected\n");
  
  const streamClosed = new Promise<void>((resolve, reject) => {
    stream.on("error", (error) => {
      console.error("❌ Stream error:", error);
      reject(error);
    });
    stream.on("end", resolve);
    stream.on("close", resolve);
  });
  
  // Handle data
  stream.on("data", async (data) => {
    const receivedAt = Date.now();
    
    try {
      if (!data?.transaction) return;
      
      const txInfo = data.transaction.transaction ?? data.transaction;
      const meta = txInfo.meta ?? data.transaction.meta;
      if (!meta) return;
      
      // Extract new tokens
      const postBalances = meta.postTokenBalances || [];
      const preBalances = meta.preTokenBalances || [];
      const preMints = new Set(preBalances.map((b: any) => b.mint).filter(Boolean));
      
      const newTokens = postBalances
        .filter((b: any) => b.mint && !preMints.has(b.mint))
        .map((b: any) => ({
          mint: b.mint,
          owner: b.owner || "unknown",
        }));
      
      if (newTokens.length === 0) return;
      
      // Process each token (async, don't block stream)
      for (const token of newTokens) {
        processToken(token.mint, token.owner, receivedAt).catch(e => 
          console.error(`Token processing failed: ${e.message}`)
        );
      }
      
    } catch (error) {
      console.error("Stream processing error:", error);
    }
  });
  
  // Send subscription
  await new Promise<void>((resolve, reject) => {
    stream.write(args, (err: any) => err ? reject(err) : resolve());
  });
  
  await streamClosed;
}

/**
 * Subscribe with auto-restart
 */
async function subscribeCommand(client: Client, args: any) {
  while (true) {
    try {
      await handleStream(client, args);
    } catch (error) {
      console.error("⚠️  Restarting in 1s...", error);
      await new Promise(r => setTimeout(r, 1000));
    }
  }
}

// Main
async function main() {
  console.log("🚀 FULL SNIPER - REAL JITO SENDING");
  console.log("===================================\n");
  console.log(`💰 Buy Amount: ${config.strategy.buy_amount_sol} SOL`);
  console.log(`📊 Slippage: ${config.strategy.max_slippage_bps / 100}%`);
  console.log(`⚡ Priority Fee: ${config.jito.priority_fee_lamports} lamports`);
  console.log(`🎯 Trader: ${trader.publicKey.toBase58()}`);
  console.log(`🔗 Jito: ${config.jito.block_engine_url}`);
  console.log(`🔗 RPC: ${config.rpc.primary_url}`);
  console.log(`📡 Geyser: ${config.geyser.endpoint}`);
  console.log(`📡 Watching: ${PUMPFUN_PROGRAM}\n`);
  
  const client = new Client(config.geyser.endpoint, config.geyser.auth_token, undefined);
  
  const request: any = {
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
    commitment: CommitmentLevel.CONFIRMED,
  };
  
  await subscribeCommand(client, request);
}

// Handle shutdown
process.on("SIGINT", () => {
  const runtime = Math.floor((Date.now() - metrics.startTime) / 1000);
  console.log("\n\n📊 FINAL STATS");
  console.log("===============");
  console.log(`Runtime: ${runtime}s`);
  console.log(`Tokens Detected: ${metrics.tokensDetected}`);
  console.log(`TX Built: ${metrics.txBuilt}`);
  console.log(`TX Simulated: ${metrics.txSimulated}`);
  console.log(`  - Success: ${metrics.simSuccess}`);
  console.log(`  - Failed: ${metrics.simFailed}`);
  console.log(`TX Sent: ${metrics.txSent}`);
  console.log(`TX Confirmed: ${metrics.txConfirmed}`);
  console.log(`TX Failed: ${metrics.txFailed}`);
  console.log("\n👋 Shutdown complete");
  process.exit(0);
});

main().catch((error) => {
  console.error("💥 Fatal:", error);
  process.exit(1);
});

