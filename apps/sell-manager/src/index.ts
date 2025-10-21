#!/usr/bin/env node
/**
 * SELL MANAGER - Separate from buy loop
 * 
 * Monitors Geyser for OTHER PEOPLE's buys on OUR positions
 * Auto-sells when:
 * 1. Other buys detected (someone else buying = price going up)
 * 2. Timer expires (configurable hold time)
 */

import "dotenv/config";
import Client, { CommitmentLevel } from "@triton-one/yellowstone-grpc";
import { Connection, Keypair, PublicKey, LAMPORTS_PER_SOL } from "@solana/web3.js";
import { getAssociatedTokenAddressSync, TOKEN_PROGRAM_ID } from "@solana/spl-token";
import { readFileSync } from "fs";
import { loadConfig } from "@fresh-sniper/config";
import { buildSellTransaction } from "@fresh-sniper/transactions";

const PUMPFUN_PROGRAM = "6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P";

const config = loadConfig();
const TRADER_KEYPAIR_PATH = process.env.TRADER_KEYPAIR_PATH || "./keypairs/trader.json";
const keypairData = JSON.parse(readFileSync(TRADER_KEYPAIR_PATH, "utf-8"));
const trader = Keypair.fromSecretKey(Uint8Array.from(keypairData));

console.log("🎯 SELL MANAGER - Auto-sell on activity");
console.log("========================================\n");
console.log(`Trader: ${trader.publicKey.toBase58()}`);

const autoSellCfg = (config.strategy as any).auto_sell || { strategy: "time_based", hold_time_seconds: 60 };
console.log(`Strategy: ${autoSellCfg.strategy}`);
console.log(`Hold time: ${autoSellCfg.hold_time_seconds}s\n`);

interface Position {
  mint: PublicKey;
  mintStr: string;
  creator: PublicKey;
  buyTimestamp: number;
  buySignature: string;
  sellTimer: NodeJS.Timeout;
  otherBuysDetected: boolean;
}

const positions = new Map<string, Position>();

/**
 * Send transaction via Jito
 */
async function sendViaJito(signedTx: Buffer): Promise<string> {
  const payload = {
    jsonrpc: "2.0",
    id: 1,
    method: "sendTransaction",
    params: [signedTx.toString("base64"), { encoding: "base64" }],
  };

  const response = await fetch(config.jito.block_engine_url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });

  const data = await response.json();
  if (data.error) throw new Error(data.error.message);
  return data.result;
}

/**
 * Get token balance
 */
async function getTokenBalance(connection: Connection, mint: PublicKey): Promise<number> {
  try {
    const ata = getAssociatedTokenAddressSync(mint, trader.publicKey);
    const account = await connection.getAccountInfo(ata);
    if (!account || account.data.length < 72) return 0;
    return Number(account.data.readBigUInt64LE(64)) / 1e6;
  } catch {
    return 0;
  }
}

/**
 * Execute sell
 */
async function executeSell(mintStr: string, reason: string) {
  const position = positions.get(mintStr);
  if (!position) return;

  console.log(`\n💰 SELLING ${mintStr.slice(0, 8)}... (${reason})`);

  try {
    const connection = new Connection(config.rpc.primary_url, "confirmed");
    const balance = await getTokenBalance(connection, position.mint);

    if (balance === 0) {
      console.log(`   ⏭️  No tokens to sell`);
      positions.delete(mintStr);
      return;
    }

    console.log(`   Balance: ${balance.toLocaleString()} tokens`);

    const { transaction } = await buildSellTransaction({
      connection,
      seller: trader.publicKey,
      mint: position.mint,
      tokenAmount: balance,
      slippageBps: autoSellCfg.sell_slippage_bps || 1000,
      priorityFeeLamports: autoSellCfg.sell_priority_fee || 5000000,
    });

    transaction.sign(trader);
    const signature = await sendViaJito(transaction.serialize());

    console.log(`   ✅ Sent: ${signature.slice(0, 16)}...`);

    const holdTime = Math.floor((Date.now() - position.buyTimestamp) / 1000);
    console.log(`   ⏱️  Hold time: ${holdTime}s`);

    // Cleanup
    clearTimeout(position.sellTimer);
    positions.delete(mintStr);
  } catch (error) {
    console.log(`   ❌ Error: ${(error as Error).message}`);
  }
}

/**
 * Add position to track
 */
function addPosition(mint: PublicKey, creator: PublicKey, buySignature: string) {
  const mintStr = mint.toBase58();
  
  // Set auto-sell timer
  const holdTimeMs = (autoSellCfg.hold_time_seconds || 60) * 1000;
  const sellTimer = setTimeout(() => {
    executeSell(mintStr, "timer expired").catch(console.error);
  }, holdTimeMs);

  positions.set(mintStr, {
    mint,
    mintStr,
    creator,
    buyTimestamp: Date.now(),
    buySignature,
    sellTimer,
    otherBuysDetected: false,
  });

  console.log(`📌 Tracking: ${mintStr.slice(0, 8)}... (auto-sell in ${holdTimeMs / 1000}s)`);
}

/**
 * Handle Geyser stream - filter for OUR WALLET transactions
 */
async function handleStream(client: Client) {
  const stream = await client.subscribe();
  console.log("✅ Stream connected - filtering for your wallet transactions\n");

  stream.on("data", async (data) => {
    try {
      if (!data?.transaction) return;

      const txInfo = data.transaction.transaction ?? data.transaction;
      const meta = txInfo.meta ?? data.transaction.meta;
      if (!meta) return;

      // Check if this transaction involves our wallet
      const postBalances = meta.postTokenBalances || [];
      const preBalances = meta.preTokenBalances || [];
      
      // Look for OUR buys (we're the owner in post but not pre)
      for (const postBal of postBalances) {
        if (!postBal.mint || postBal.owner !== trader.publicKey.toBase58()) continue;
        
        const hadBefore = preBalances.some((pre: any) => pre.mint === postBal.mint && pre.owner === trader.publicKey.toBase58());
        
        if (!hadBefore) {
          // NEW position - we just bought this
          const mint = new PublicKey(postBal.mint);
          
          // Extract creator from transaction
          const accountKeys = txInfo.message?.accountKeys;
          const creator = accountKeys && accountKeys.length > 0 ? new PublicKey(accountKeys[0]) : mint;
          
          // Get signature
          const signature = txInfo.signature ? Buffer.from(txInfo.signature).toString('base64') : 'unknown';
          
          console.log(`\n🆕 Detected OUR buy: ${postBal.mint.slice(0, 8)}...`);
          addPosition(mint, creator, signature);
        } else if (positions.has(postBal.mint)) {
          // We have a position and there's activity
          const position = positions.get(postBal.mint)!;
          
          if (!position.otherBuysDetected) {
            position.otherBuysDetected = true;
            console.log(`\n📈 Activity on ${postBal.mint.slice(0, 8)}... - someone else buying!`);
            clearTimeout(position.sellTimer);
            executeSell(postBal.mint, "other buy detected").catch(console.error);
          }
        }
      }
    } catch (error) {
      // Silent
    }
  });

  // Subscribe to transactions involving OUR WALLET
  const request: any = {
    accounts: {},
    slots: {},
    transactions: {
      our_wallet: {
        vote: false,
        failed: false,
        signature: undefined,
        accountInclude: [trader.publicKey.toBase58()], // Filter for our wallet!
        accountExclude: [],
        accountRequired: [],
      },
    },
    transactionsStatus: {},
    entry: {},
    blocks: {},
    blocksMeta: {},
    accountsDataSlice: [],
    commitment: CommitmentLevel.CONFIRMED,
  };

  await new Promise<void>((resolve, reject) => {
    stream.write(request, (err: any) => (err ? reject(err) : resolve()));
  });

  return new Promise(() => {}); // Keep alive
}

// Main
async function main() {
  const client = new Client(config.geyser.endpoint, config.geyser.auth_token, undefined);
  
  console.log("🔍 Monitoring Geyser for transactions involving your wallet...");
  console.log("   Will detect your buys and track positions automatically");
  console.log("   Will sell when other buys detected or timer expires\n");
  
  await handleStream(client);
}

process.on("SIGINT", () => {
  console.log("\n\n📊 SHUTTING DOWN");
  console.log(`Active positions: ${positions.size}`);
  for (const [mint, pos] of positions.entries()) {
    clearTimeout(pos.sellTimer);
    console.log(`  - ${mint.slice(0, 8)}... (held ${Math.floor((Date.now() - pos.buyTimestamp) / 1000)}s)`);
  }
  process.exit(0);
});

main().catch(console.error);

