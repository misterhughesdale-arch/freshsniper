#!/usr/bin/env node
/**
 * DUST RECOVERY
 * 
 * Recovers SOL from a wallet with near-zero balance by:
 * 1. Selling all tokens (gets SOL back)
 * 2. Closing empty ATAs to reclaim rent (~0.00203 SOL each)
 * 3. Batching operations to minimize transaction fees
 * 
 * This script works even with DUST amounts of SOL
 */

import "dotenv/config";
import { Connection, Keypair, PublicKey, Transaction, VersionedTransaction } from "@solana/web3.js";
import { createCloseAccountInstruction, TOKEN_PROGRAM_ID } from "@solana/spl-token";
import { buildSellTransaction } from "../packages/transactions/src/pumpfun/builders";
import { readFileSync } from "fs";

const HELIUS_RPC = process.env.SOLANA_RPC_PRIMARY!;
const TRADER_KEYPAIR_PATH = process.env.TRADER_KEYPAIR_PATH || "./keypairs/trader.json";

const keypairData = JSON.parse(readFileSync(TRADER_KEYPAIR_PATH, "utf-8"));
const trader = Keypair.fromSecretKey(Uint8Array.from(keypairData));

console.log("💰 DUST RECOVERY");
console.log("================\n");
console.log(`Wallet: ${trader.publicKey.toBase58()}\n`);

async function main() {
  const connection = new Connection(HELIUS_RPC, "confirmed");

  // Check current balance
  const balance = await connection.getBalance(trader.publicKey);
  const solBalance = balance / 1e9;
  console.log(`Current Balance: ${solBalance.toFixed(6)} SOL\n`);

  if (solBalance < 0.000005) {
    console.log("⚠️  WARNING: Very low balance. May not have enough for fees.");
    console.log("   Rent reclaim will help but you might need to add ~0.001 SOL\n");
  }

  // Get all token accounts
  const tokenAccounts = await connection.getParsedTokenAccountsByOwner(trader.publicKey, {
    programId: TOKEN_PROGRAM_ID,
  });

  console.log(`Found ${tokenAccounts.value.length} token accounts\n`);

  // Separate into tokens to sell and empty ATAs to close
  const toSell: Array<{ mint: string; balance: number; ata: PublicKey }> = [];
  const toClose: Array<{ mint: string; ata: PublicKey }> = [];

  for (const accountInfo of tokenAccounts.value) {
    const account = accountInfo.account.data.parsed.info;
    const balance = parseFloat(account.tokenAmount.uiAmount);

    if (balance > 0) {
      toSell.push({
        mint: account.mint,
        balance,
        ata: accountInfo.pubkey,
      });
    } else {
      toClose.push({
        mint: account.mint,
        ata: accountInfo.pubkey,
      });
    }
  }

  console.log(`📊 Analysis:`);
  console.log(`   Tokens to sell: ${toSell.length}`);
  console.log(`   Empty ATAs to close: ${toClose.length}`);
  console.log(`   Estimated rent recovery: ${(toClose.length * 0.00203).toFixed(6)} SOL\n`);

  // Strategy: Sell ONE token at a time, then close its ATA immediately
  // This maximizes rent recovery before next transaction
  
  let totalSellProceeds = 0;
  let totalRentRecovered = 0;
  let sellCount = 0;
  let closeCount = 0;

  for (const token of toSell) {
    try {
      console.log(`\n${sellCount + 1}. Selling ${token.mint.slice(0, 8)}... (${token.balance.toLocaleString()} tokens)`);

      // Check balance BEFORE
      const balanceBefore = await connection.getBalance(trader.publicKey);

      // Check if bonding curve exists (token might be graduated or sold out)
      const mintPubkey = new PublicKey(token.mint);
      const [bondingCurve] = PublicKey.findProgramAddressSync(
        [Buffer.from("bonding-curve"), mintPubkey.toBuffer()],
        new PublicKey("6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P")
      );
      
      const curveAccount = await connection.getAccountInfo(bondingCurve);
      if (!curveAccount) {
        console.log(`   ⏭️  Skipped: Bonding curve graduated/missing (token on Raydium?)`);
        // Just close the ATA to reclaim rent
        toClose.push({ mint: token.mint, ata: token.ata });
        continue;
      }

      // Build sell transaction
      const { transaction } = await buildSellTransaction({
        connection,
        seller: trader.publicKey,
        mint: new PublicKey(token.mint),
        tokenAmount: token.balance,
        slippageBps: 2000, // 20% slippage for dust recovery (just get SOMETHING)
        priorityFeeLamports: 1000, // Minimal priority fee
        computeUnits: 250000,
      });

      // Add ATA close instruction to same transaction (saves a tx fee!)
      transaction.add(
        createCloseAccountInstruction(
          token.ata,
          trader.publicKey, // rent destination
          trader.publicKey, // authority
          [],
          TOKEN_PROGRAM_ID,
        ),
      );

      // Sign and send
      transaction.sign(trader);
      const signature = await connection.sendRawTransaction(transaction.serialize(), {
        skipPreflight: false,
      });

      console.log(`   📤 Sent: ${signature.slice(0, 16)}...`);
      
      // Wait for confirmation
      const confirmation = await connection.confirmTransaction(signature, "confirmed");

      if (confirmation.value.err) {
        console.log(`   ❌ Failed: ${JSON.stringify(confirmation.value.err)}`);
      } else {
        // Check balance AFTER
        const balanceAfter = await connection.getBalance(trader.publicKey);
        const netChange = (balanceAfter - balanceBefore) / 1e9;
        const sellProceeds = netChange - 0.00203; // Subtract rent, rest is from sell
        const rentRecovered = 0.00203;
        
        console.log(`   ✅ Confirmed!`);
        console.log(`      Sell proceeds: ${sellProceeds.toFixed(6)} SOL`);
        console.log(`      Rent recovered: ${rentRecovered.toFixed(6)} SOL`);
        console.log(`      Total: ${netChange.toFixed(6)} SOL`);
        
        sellCount++;
        closeCount++;
        totalSellProceeds += sellProceeds;
        totalRentRecovered += rentRecovered;
      }

      // Small delay to avoid rate limits
      await new Promise((r) => setTimeout(r, 500));
    } catch (error) {
      console.log(`   ❌ Error: ${(error as Error).message}`);
    }
  }

  // Close remaining empty ATAs in bulk transactions (100 per tx max)
  if (toClose.length > 0) {
    console.log(`\n📦 Closing ${toClose.length} empty ATAs in bulk...\n`);

    const batchSize = 100; // Solana tx limit
    for (let i = 0; i < toClose.length; i += batchSize) {
      const batch = toClose.slice(i, i + batchSize);
      const transaction = new Transaction();

      for (const { ata } of batch) {
        transaction.add(
          createCloseAccountInstruction(
            ata,
            trader.publicKey,
            trader.publicKey,
            [],
            TOKEN_PROGRAM_ID,
          ),
        );
      }

      try {
        const { blockhash } = await connection.getLatestBlockhash();
        transaction.recentBlockhash = blockhash;
        transaction.feePayer = trader.publicKey;

        transaction.sign(trader);
        const signature = await connection.sendRawTransaction(transaction.serialize(), {
          skipPreflight: false,
        });

        console.log(`   📤 Batch ${Math.floor(i / batchSize) + 1}: ${signature.slice(0, 16)}...`);

        const confirmation = await connection.confirmTransaction(signature, "confirmed");

        if (confirmation.value.err) {
          console.log(`   ❌ Failed: ${JSON.stringify(confirmation.value.err)}`);
        } else {
          const recovered = batch.length * 0.00203;
          console.log(`   ✅ Closed ${batch.length} ATAs, recovered ${recovered.toFixed(6)} SOL`);
          closeCount += batch.length;
          totalRecovered += recovered;
        }

        await new Promise((r) => setTimeout(r, 500));
      } catch (error) {
        console.log(`   ❌ Error: ${(error as Error).message}`);
      }
    }
  }

  // Final balance
  const finalBalance = await connection.getBalance(trader.publicKey);
  const finalSol = finalBalance / 1e9;

  console.log(`\n📊 RECOVERY COMPLETE`);
  console.log(`===================`);
  console.log(`Tokens sold: ${sellCount}`);
  console.log(`ATAs closed: ${closeCount}`);
  console.log(`Sell proceeds: ${totalSellProceeds.toFixed(6)} SOL`);
  console.log(`Rent recovered: ${totalRentRecovered.toFixed(6)} SOL`);
  console.log(`Total recovered: ${(totalSellProceeds + totalRentRecovered).toFixed(6)} SOL`);
  console.log(`Starting balance: ${solBalance.toFixed(6)} SOL`);
  console.log(`Final balance: ${finalSol.toFixed(6)} SOL`);
  console.log(`Net change: ${(finalSol - solBalance).toFixed(6)} SOL`);
}

main().catch(console.error);

