#!/usr/bin/env node
/**
 * CALCULATE PNL - Last 15 Minutes
 * 
 * Uses Helius API to fetch all transactions and calculate actual P&L
 */

import "dotenv/config";

const HELIUS_API_KEY = process.env.SOLANA_RPC_PRIMARY!.match(/api-key=([^&]+)/)?.[1];
const HELIUS_BASE = `https://api.helius.xyz/v0`;

// Just hardcode your wallet address - easier than loading keypair
const traderAddress = "EuZhGRPZXzB2rPwdy7GncBKJgyAv65NCduWgtFjoBdR5";

interface ParsedTransaction {
  signature: string;
  timestamp: number;
  type: "buy" | "sell" | "rent_reclaim" | "unknown";
  mint?: string;
  solAmount: number;
  tokenAmount: number;
  fee: number;
}

/**
 * Fetch transactions from Helius
 */
async function fetchTransactions(address: string, beforeSignature?: string): Promise<any[]> {
  const url = `${HELIUS_BASE}/addresses/${address}/transactions?api-key=${HELIUS_API_KEY}&limit=100${beforeSignature ? `&before=${beforeSignature}` : ''}`;
  
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`Helius API error: ${response.statusText}`);
  }
  
  return await response.json();
}

/**
 * Parse transaction to extract trade info
 */
function parseTransaction(tx: any): ParsedTransaction {
  const signature = tx.signature;
  const timestamp = tx.timestamp * 1000; // Convert to ms
  const fee = (tx.fee || 0) / 1e9;
  
  // Check if it's a pump.fun transaction
  const isPumpFun = tx.accountData?.some((acc: any) => 
    acc.account === "6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P"
  );
  
  // Check if it's a rent reclaim (close account instruction)
  const isRentReclaim = tx.instructions?.some((ix: any) => 
    ix.programId === "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA" &&
    ix.parsed?.type === "closeAccount"
  );
  
  if (isRentReclaim) {
    // Calculate rent reclaimed
    const rentReceived = tx.nativeTransfers
      ?.filter((t: any) => t.toUserAccount === traderAddress)
      .reduce((sum: number, t: any) => sum + t.amount / 1e9, 0) || 0;
    
    return { 
      signature, 
      timestamp, 
      type: "rent_reclaim", 
      solAmount: rentReceived, 
      tokenAmount: 0, 
      fee 
    };
  }
  
  if (!isPumpFun) {
    return { signature, timestamp, type: "unknown", solAmount: 0, tokenAmount: 0, fee };
  }
  
  // Parse token changes
  const tokenBalances = tx.tokenTransfers || [];
  const nativeTransfers = tx.nativeTransfers || [];
  
  // Determine if buy or sell based on SOL flow
  let solAmount = 0;
  let type: "buy" | "sell" | "unknown" = "unknown";
  let mint: string | undefined;
  let tokenAmount = 0;
  
  for (const transfer of nativeTransfers) {
    if (transfer.fromUserAccount === traderAddress) {
      // SOL leaving = buy
      solAmount += transfer.amount / 1e9;
      type = "buy";
    } else if (transfer.toUserAccount === traderAddress) {
      // SOL arriving = sell
      solAmount += transfer.amount / 1e9;
      type = "sell";
    }
  }
  
  for (const transfer of tokenBalances) {
    if (transfer.toUserAccount === traderAddress || transfer.fromUserAccount === traderAddress) {
      mint = transfer.mint;
      tokenAmount = transfer.tokenAmount || 0;
    }
  }
  
  return { signature, timestamp, type, mint, solAmount, tokenAmount, fee };
}

/**
 * Main
 */
async function main() {
  console.log("📊 PNL CALCULATOR - Last 15 Minutes");
  console.log("====================================\n");
  console.log(`Wallet: ${traderAddress}\n`);
  
  const now = Date.now();
  const fifteenMinutesAgo = now - (15 * 60 * 1000);
  
  console.log("⏳ Fetching transactions from Helius...");
  
  let allTxs: any[] = [];
  let beforeSig: string | undefined;
  let done = false;
  
  // Fetch transactions in batches until we go back 15 minutes
  while (!done) {
    const txs = await fetchTransactions(traderAddress, beforeSig);
    
    if (txs.length === 0) {
      done = true;
      break;
    }
    
    for (const tx of txs) {
      const txTime = tx.timestamp * 1000;
      
      if (txTime < fifteenMinutesAgo) {
        done = true;
        break;
      }
      
      allTxs.push(tx);
    }
    
    beforeSig = txs[txs.length - 1]?.signature;
    
    // Safety: max 10 pages
    if (allTxs.length > 1000) {
      console.log("⚠️  Hit 1000 transaction limit");
      break;
    }
  }
  
  console.log(`✅ Fetched ${allTxs.length} transactions\n`);
  
  // Debug: Show first transaction structure
  if (allTxs.length > 0) {
    console.log("🔍 Sample transaction structure:");
    console.log(JSON.stringify(allTxs[0], null, 2).slice(0, 1000));
    console.log("\n");
  }
  
  // Parse all transactions
  const trades = allTxs.map(parseTransaction).filter(t => t.type !== "unknown");
  
  const buys = trades.filter(t => t.type === "buy");
  const sells = trades.filter(t => t.type === "sell");
  const rentReclaims = trades.filter(t => t.type === "rent_reclaim");
  
  // Debug: Show what we parsed
  console.log(`🔍 Parsed: ${buys.length} buys, ${sells.length} sells, ${rentReclaims.length} rent reclaims\n`);
  
  const totalBuySpent = buys.reduce((sum, t) => sum + t.solAmount, 0);
  const totalBuyFees = buys.reduce((sum, t) => sum + t.fee, 0);
  const totalSellReceived = sells.reduce((sum, t) => sum + t.solAmount, 0);
  const totalSellFees = sells.reduce((sum, t) => sum + t.fee, 0);
  const totalRentReclaimed = rentReclaims.reduce((sum, t) => sum + t.solAmount, 0);
  const totalRentFees = rentReclaims.reduce((sum, t) => sum + t.fee, 0);
  
  // Print results
  console.log("=".repeat(60));
  console.log("📊 PNL REPORT - LAST 15 MINUTES");
  console.log("=".repeat(60));
  
  console.log(`\n📈 Trading Activity:`);
  console.log(`  Buy transactions: ${buys.length}`);
  console.log(`  Sell transactions: ${sells.length}`);
  console.log(`  Rent reclaims: ${rentReclaims.length}`);
  console.log(`  Total transactions: ${trades.length}`);
  
  console.log(`\n💰 Buys:`);
  console.log(`  Total SOL spent: ${totalBuySpent.toFixed(6)} SOL`);
  console.log(`  Total fees: ${totalBuyFees.toFixed(6)} SOL`);
  console.log(`  Total cost: ${(totalBuySpent + totalBuyFees).toFixed(6)} SOL`);
  
  console.log(`\n💸 Sells:`);
  console.log(`  Total SOL received: ${totalSellReceived.toFixed(6)} SOL`);
  console.log(`  Total fees: ${totalSellFees.toFixed(6)} SOL`);
  console.log(`  Net received: ${(totalSellReceived - totalSellFees).toFixed(6)} SOL`);
  
  console.log(`\n💰 Rent Reclaims:`);
  console.log(`  Total SOL reclaimed: ${totalRentReclaimed.toFixed(6)} SOL`);
  console.log(`  Total fees: ${totalRentFees.toFixed(6)} SOL`);
  console.log(`  Net reclaimed: ${(totalRentReclaimed - totalRentFees).toFixed(6)} SOL`);
  
  const grossPNL = totalSellReceived + totalRentReclaimed - totalBuySpent;
  const netPNL = grossPNL - totalBuyFees - totalSellFees - totalRentFees;
  const totalFees = totalBuyFees + totalSellFees + totalRentFees;
  const roi = totalBuySpent > 0 ? (netPNL / totalBuySpent) * 100 : 0;
  
  console.log(`\n📊 Profit & Loss:`);
  console.log(`  Gross P&L: ${grossPNL >= 0 ? '+' : ''}${grossPNL.toFixed(6)} SOL`);
  console.log(`  Total fees: -${totalFees.toFixed(6)} SOL`);
  console.log(`  Net P&L: ${netPNL >= 0 ? '+' : ''}${netPNL.toFixed(6)} SOL`);
  console.log(`  ROI: ${roi >= 0 ? '+' : ''}${roi.toFixed(2)}%`);
  
  console.log(`\n💵 USD Equivalent (@ $200/SOL):`);
  console.log(`  Gross P&L: ${grossPNL >= 0 ? '+' : ''}$${(grossPNL * 200).toFixed(2)}`);
  console.log(`  Total fees: -$${(totalFees * 200).toFixed(2)}`);
  console.log(`  Net P&L: ${netPNL >= 0 ? '+' : ''}$${(netPNL * 200).toFixed(2)}`);
  
  console.log("\n" + "=".repeat(60));
  
  // List recent trades
  if (trades.length > 0) {
    console.log("\n📜 Recent Trades:");
    trades.slice(0, 10).forEach((t, i) => {
      const timeAgo = Math.floor((now - t.timestamp) / 1000);
      console.log(`  ${i + 1}. ${t.type.toUpperCase()} - ${t.solAmount.toFixed(6)} SOL (${timeAgo}s ago)`);
      console.log(`     ${t.signature.slice(0, 16)}... - https://solscan.io/tx/${t.signature}`);
    });
  }
}

main().catch(console.error);

