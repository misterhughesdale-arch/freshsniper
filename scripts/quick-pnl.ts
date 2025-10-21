#!/usr/bin/env node
/**
 * QUICK PNL - Just compare wallet balance before/after
 */

import "dotenv/config";
import { Connection, PublicKey } from "@solana/web3.js";

const RPC_URL = process.env.SOLANA_RPC_PRIMARY!;
const WALLET = "EuZhGRPZXzB2rPwdy7GncBKJgyAv65NCduWgtFjoBdR5";

async function main() {
  console.log("📊 QUICK PNL CHECK");
  console.log("==================\n");
  
  const connection = new Connection(RPC_URL, "confirmed");
  const pubkey = new PublicKey(WALLET);
  
  const balance = await connection.getBalance(pubkey);
  const balanceSOL = balance / 1e9;
  
  console.log(`Wallet: ${WALLET}`);
  console.log(`Current balance: ${balanceSOL.toFixed(6)} SOL`);
  console.log(`\nTo calculate P&L:`);
  console.log(`  Starting balance - Current balance = Net P&L`);
  console.log(`\nIf you started with 0.1 SOL:`);
  console.log(`  0.1 - ${balanceSOL.toFixed(6)} = ${(0.1 - balanceSOL).toFixed(6)} SOL loss`);
  console.log(`  = $${((0.1 - balanceSOL) * 200).toFixed(2)} at $200/SOL`);
  console.log(`\nCheck your transactions on Solscan:`);
  console.log(`  https://solscan.io/account/${WALLET}`);
}

main().catch(console.error);

