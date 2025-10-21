#!/usr/bin/env node
/**
 * EMERGENCY SELL ALL
 * 
 * Sells ALL tokens from all ATAs in the wallet
 * Use when you need to exit positions quickly
 */

import "dotenv/config";
import { Connection, Keypair, PublicKey } from "@solana/web3.js";
import { getAccount, TOKEN_PROGRAM_ID } from "@solana/spl-token";
import { buildSellTransaction } from "../packages/transactions/src/pumpfun/builders";
import { readFileSync } from "fs";

const HELIUS_RPC = process.env.SOLANA_RPC_PRIMARY!;
const JITO_URL = "https://mainnet.block-engine.jito.wtf/api/v1/transactions";
const TRADER_KEYPAIR_PATH = process.env.TRADER_KEYPAIR_PATH || "./keypairs/trader.json";

const keypairData = JSON.parse(readFileSync(TRADER_KEYPAIR_PATH, "utf-8"));
const trader = Keypair.fromSecretKey(Uint8Array.from(keypairData));

console.log("🚨 EMERGENCY SELL ALL");
console.log("====================\n");
console.log(`Wallet: ${trader.publicKey.toBase58()}\n`);

async function sendViaJito(signedTx: Buffer): Promise<string> {
  const payload = {
    jsonrpc: "2.0",
    id: 1,
    method: "sendTransaction",
    params: [signedTx.toString("base64"), { encoding: "base64" }],
  };

  const response = await fetch(JITO_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });

  const data = await response.json();
  if (data.error) throw new Error(data.error.message);
  return data.result;
}

async function main() {
  const connection = new Connection(HELIUS_RPC, "confirmed");

  // Get all token accounts
  const tokenAccounts = await connection.getParsedTokenAccountsByOwner(trader.publicKey, {
    programId: TOKEN_PROGRAM_ID,
  });

  console.log(`Found ${tokenAccounts.value.length} token accounts\n`);

  const sellPromises = tokenAccounts.value.map(async (accountInfo, index) => {
    const account = accountInfo.account.data.parsed.info;
    const mint = new PublicKey(account.mint);
    const balance = parseFloat(account.tokenAmount.uiAmount);

    if (balance === 0) {
      console.log(`${index + 1}. ${account.mint.slice(0, 8)}... - SKIP (zero balance)`);
      return null;
    }

    console.log(`${index + 1}. ${account.mint.slice(0, 8)}... - ${balance.toLocaleString()} tokens`);

    try {
      // Fetch creator (needed for sell)
      const [bondingCurve] = deriveBondingCurvePDA(mint);
      const curveState = await fetchBondingCurveState(connection, bondingCurve);
      
      // Build sell
      const { transaction } = await buildSellTransaction({
        connection,
        seller: trader.publicKey,
        mint,
        creator: curveState.creator,
        tokenAmount: balance,
        slippageBps: 3000, // 30% slippage for emergency
        priorityFeeLamports: 1, // Minimal fee
      });

      // Sign and send (no simulation for speed)
      transaction.sign(trader);
      const signature = await sendViaJito(transaction.serialize());

      console.log(`   ✅ Sent: ${signature.slice(0, 16)}...`);
      return { mint: account.mint, signature, balance };
    } catch (error) {
      console.log(`   ❌ Error: ${(error as Error).message}`);
      return null;
    }
  });

  const results = await Promise.allSettled(sellPromises);
  const successful = results.filter((r) => r.status === "fulfilled" && r.value !== null).length;

  console.log(`\n📊 Results: ${successful}/${tokenAccounts.value.length} sold`);
}

main().catch(console.error);

