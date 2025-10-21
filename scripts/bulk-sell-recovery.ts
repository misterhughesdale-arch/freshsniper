#!/usr/bin/env node
/**
 * BULK SELL RECOVERY
 * 
 * Batches multiple sell + close instructions into single transactions
 * Much faster and cheaper than one-by-one
 */

import "dotenv/config";
import { Connection, Keypair, PublicKey, Transaction, ComputeBudgetProgram } from "@solana/web3.js";
import { createCloseAccountInstruction, TOKEN_PROGRAM_ID, getAssociatedTokenAddressSync } from "@solana/spl-token";
import { readFileSync } from "fs";
import {
  deriveBondingCurvePDA,
  deriveAssociatedBondingCurvePDA,
  deriveAssociatedTokenAddress,
  deriveCreatorVaultPDA,
  deriveFeeConfigPDA,
} from "../packages/transactions/src/pumpfun/pdas";
import { fetchBondingCurveState } from "../packages/transactions/src/pumpfun/curve-parser";
import {
  PUMP_GLOBAL,
  PUMP_FEE_RECIPIENT,
  PUMP_EVENT_AUTHORITY,
  PUMP_PROGRAM_ID,
  PUMP_FEE_PROGRAM,
  SYSTEM_PROGRAM_ID,
  TOKEN_PROGRAM_ID as PUMP_TOKEN_PROGRAM_ID,
} from "../packages/transactions/src/pumpfun/constants";

const HELIUS_RPC = process.env.SOLANA_RPC_PRIMARY!;
const TRADER_KEYPAIR_PATH = process.env.TRADER_KEYPAIR_PATH || "./keypairs/trader.json";
const SELL_DISCRIMINATOR = Buffer.from([51, 230, 133, 164, 1, 127, 131, 173]);

const keypairData = JSON.parse(readFileSync(TRADER_KEYPAIR_PATH, "utf-8"));
const trader = Keypair.fromSecretKey(Uint8Array.from(keypairData));

console.log("⚡ BULK SELL RECOVERY");
console.log("====================\n");
console.log(`Wallet: ${trader.publicKey.toBase58()}\n`);

async function main() {
  const connection = new Connection(HELIUS_RPC, "confirmed");

  const balanceStart = await connection.getBalance(trader.publicKey);
  console.log(`Starting Balance: ${(balanceStart / 1e9).toFixed(6)} SOL\n`);

  // Get all token accounts
  const tokenAccounts = await connection.getParsedTokenAccountsByOwner(trader.publicKey, {
    programId: TOKEN_PROGRAM_ID,
  });

  const toSell = tokenAccounts.value
    .map((acc) => ({
      mint: acc.account.data.parsed.info.mint,
      balance: parseFloat(acc.account.data.parsed.info.tokenAmount.uiAmount),
      ata: acc.pubkey,
    }))
    .filter((t) => t.balance > 0);

  console.log(`Found ${toSell.length} tokens to sell\n`);

  // Batch size: ~3-5 sells per transaction (each sell is ~14 accounts = ~280 bytes)
  const BATCH_SIZE = 3;
  let totalSold = 0;

  for (let i = 0; i < toSell.length; i += BATCH_SIZE) {
    const batch = toSell.slice(i, i + BATCH_SIZE);
    const batchNum = Math.floor(i / BATCH_SIZE) + 1;
    
    console.log(`\n📦 Batch ${batchNum} (${batch.length} tokens)`);
    
    try {
      const tx = new Transaction();
      
      // Add compute budget
      tx.add(ComputeBudgetProgram.setComputeUnitLimit({ units: 500000 }));
      tx.add(ComputeBudgetProgram.setComputeUnitPrice({ microLamports: 1000 }));

      // Build all sell instructions
      for (const token of batch) {
        console.log(`   ${token.mint.slice(0, 8)}... - ${token.balance.toLocaleString()} tokens`);
        
        const mint = new PublicKey(token.mint);
        const [bondingCurve] = deriveBondingCurvePDA(mint);
        const associatedBondingCurve = deriveAssociatedBondingCurvePDA(mint);
        const sellerAta = getAssociatedTokenAddressSync(mint, trader.publicKey);
        
        // Fetch creator
        const curveState = await fetchBondingCurveState(connection, bondingCurve);
        const [creatorVault] = deriveCreatorVaultPDA(curveState.creator);
        const [feeConfig] = deriveFeeConfigPDA();
        
        // Sell instruction data
        const tokenAmountRaw = BigInt(Math.floor(token.balance * 1e6));
        const minSolOutput = BigInt(0);
        
        const data = Buffer.alloc(25);
        SELL_DISCRIMINATOR.copy(data, 0);
        data.writeBigUInt64LE(tokenAmountRaw, 8);
        data.writeBigUInt64LE(minSolOutput, 16);
        data.writeUInt8(0, 24);
        
        // Add sell instruction
        tx.add({
          programId: PUMP_PROGRAM_ID,
          keys: [
            { pubkey: PUMP_GLOBAL, isSigner: false, isWritable: false },
            { pubkey: PUMP_FEE_RECIPIENT, isSigner: false, isWritable: true },
            { pubkey: mint, isSigner: false, isWritable: false },
            { pubkey: bondingCurve, isSigner: false, isWritable: true },
            { pubkey: associatedBondingCurve, isSigner: false, isWritable: true },
            { pubkey: sellerAta, isSigner: false, isWritable: true },
            { pubkey: trader.publicKey, isSigner: true, isWritable: true },
            { pubkey: SYSTEM_PROGRAM_ID, isSigner: false, isWritable: false },
            { pubkey: creatorVault, isSigner: false, isWritable: true },
            { pubkey: PUMP_TOKEN_PROGRAM_ID, isSigner: false, isWritable: false },
            { pubkey: PUMP_EVENT_AUTHORITY, isSigner: false, isWritable: false },
            { pubkey: PUMP_PROGRAM_ID, isSigner: false, isWritable: false },
            { pubkey: feeConfig, isSigner: false, isWritable: false },
            { pubkey: PUMP_FEE_PROGRAM, isSigner: false, isWritable: false },
          ],
          data,
        });
        
        // Close ATA
        tx.add(
          createCloseAccountInstruction(
            token.ata,
            trader.publicKey,
            trader.publicKey,
            [],
            TOKEN_PROGRAM_ID,
          ),
        );
      }

      // Get blockhash and send
      const { blockhash } = await connection.getLatestBlockhash();
      tx.recentBlockhash = blockhash;
      tx.feePayer = trader.publicKey;
      tx.sign(trader);

      const signature = await connection.sendRawTransaction(tx.serialize(), { skipPreflight: false });
      console.log(`   📤 Sent: ${signature.slice(0, 16)}...`);

      const confirmation = await connection.confirmTransaction(signature, "confirmed");
      if (confirmation.value.err) {
        console.log(`   ❌ Failed: ${JSON.stringify(confirmation.value.err)}`);
      } else {
        console.log(`   ✅ Confirmed ${batch.length} sells + closes!`);
        totalSold += batch.length;
      }

      await new Promise((r) => setTimeout(r, 500));
    } catch (error) {
      console.log(`   ❌ Batch error: ${(error as Error).message}`);
    }
  }

  const balanceEnd = await connection.getBalance(trader.publicKey);
  const recovered = (balanceEnd - balanceStart) / 1e9;

  console.log(`\n📊 BULK RECOVERY COMPLETE`);
  console.log(`========================`);
  console.log(`Tokens sold: ${totalSold}`);
  console.log(`Starting: ${(balanceStart / 1e9).toFixed(6)} SOL`);
  console.log(`Final: ${(balanceEnd / 1e9).toFixed(6)} SOL`);
  console.log(`Recovered: ${recovered.toFixed(6)} SOL`);
}

main().catch(console.error);

