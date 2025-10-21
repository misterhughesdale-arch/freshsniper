#!/usr/bin/env node
/**
 * PNL MONITOR SERVICE
 * 
 * Monitors actual on-chain balance changes to calculate real P&L
 * Tracks profitability over rolling windows (30s, 5m, 1hr)
 * Implements circuit breaker to pause bot if losing money
 */

import "dotenv/config";
import { Connection, Keypair, PublicKey, LAMPORTS_PER_SOL } from "@solana/web3.js";
import { readFileSync, writeFileSync, existsSync } from "fs";
import { loadConfig } from "../../../packages/config/src/index";

const config = loadConfig();
const TRADER_KEYPAIR_PATH = process.env.TRADER_KEYPAIR_PATH || "./keypairs/trader.json";
const keypairData = JSON.parse(readFileSync(TRADER_KEYPAIR_PATH, "utf-8"));
const trader = Keypair.fromSecretKey(Uint8Array.from(keypairData));

const CIRCUIT_BREAKER_FILE = "logs/circuit-breaker.json";

interface BalanceSnapshot {
  timestamp: number;
  balance: number; // SOL
  signature?: string;
  type?: "buy" | "sell" | "checkpoint";
}

interface PnLWindow {
  period: string;
  startBalance: number;
  currentBalance: number;
  pnl: number;
  pnlPercent: number;
  transactions: number;
  wins: number;
  losses: number;
  winRate: number;
  avgFeePerTx: number;
}

interface CircuitBreakerState {
  paused: boolean;
  reason: string;
  pausedAt?: number;
  resumeAt?: number;
  losses: number;
}

class PnLMonitor {
  private snapshots: BalanceSnapshot[] = [];
  private connection: Connection;
  private startBalance: number = 0;
  private lastBalance: number = 0;
  private txCount = 0;
  private winCount = 0;
  private lossCount = 0;
  private totalFees = 0;

  // Circuit breaker config
  private readonly MAX_LOSS_PERCENT = -5; // Pause if down 5%
  private readonly MAX_CONSECUTIVE_LOSSES = 10; // Pause after 10 losses in a row
  private readonly PAUSE_DURATION_MS = 300000; // 5 minutes
  private consecutiveLosses = 0;

  constructor() {
    this.connection = new Connection(config.rpc.primary_url, "confirmed");
  }

  async start() {
    console.log("📊 PNL MONITOR SERVICE");
    console.log("======================\n");
    console.log(`Wallet: ${trader.publicKey.toBase58()}`);
    console.log(`Circuit Breaker: ${this.MAX_LOSS_PERCENT}% max loss, ${this.MAX_CONSECUTIVE_LOSSES} max consecutive losses\n`);

    // Get starting balance
    this.startBalance = await this.getBalance();
    this.lastBalance = this.startBalance;
    
    this.snapshots.push({
      timestamp: Date.now(),
      balance: this.startBalance,
      type: "checkpoint",
    });

    console.log(`Starting Balance: ${this.startBalance.toFixed(6)} SOL\n`);

    // Subscribe to account changes (WebSocket)
    this.subscribeToAccountChanges();

    // Periodic reporting
    setInterval(() => this.report(), 30000); // Every 30 seconds
    setInterval(() => this.detailedReport(), 300000); // Every 5 minutes
  }

  private async getBalance(): Promise<number> {
    const lamports = await this.connection.getBalance(trader.publicKey);
    return lamports / LAMPORTS_PER_SOL;
  }

  private subscribeToAccountChanges() {
    console.log("🔔 Subscribed to wallet balance changes via WebSocket\n");

    this.connection.onAccountChange(
      trader.publicKey,
      async (accountInfo, context) => {
        const newBalance = accountInfo.lamports / LAMPORTS_PER_SOL;
        const change = newBalance - this.lastBalance;

        // Only track if significant change (>0.0001 SOL)
        if (Math.abs(change) > 0.0001) {
          this.txCount++;

          const snapshot: BalanceSnapshot = {
            timestamp: Date.now(),
            balance: newBalance,
          };

          // Determine if win or loss
          if (change > 0) {
            this.winCount++;
            this.consecutiveLosses = 0; // Reset
            snapshot.type = "sell"; // Likely a sell
          } else {
            this.lossCount++;
            this.consecutiveLosses++;
            snapshot.type = "buy"; // Likely a buy
            this.totalFees += Math.abs(change);
          }

          this.snapshots.push(snapshot);
          this.lastBalance = newBalance;

          // Check circuit breaker
          this.checkCircuitBreaker();

          // Log transaction
          const emoji = change > 0 ? "💰" : "💸";
          const sign = change > 0 ? "+" : "";
          console.log(`${emoji} Tx #${this.txCount}: ${sign}${change.toFixed(6)} SOL | Balance: ${newBalance.toFixed(6)} SOL`);
        }
      },
      "confirmed",
    );
  }

  private checkCircuitBreaker() {
    const current = this.lastBalance;
    const pnlPercent = ((current - this.startBalance) / this.startBalance) * 100;

    let shouldPause = false;
    let reason = "";

    // Check 1: Total loss threshold
    if (pnlPercent < this.MAX_LOSS_PERCENT) {
      shouldPause = true;
      reason = `Total loss ${pnlPercent.toFixed(2)}% exceeds ${this.MAX_LOSS_PERCENT}%`;
    }

    // Check 2: Consecutive losses
    if (this.consecutiveLosses >= this.MAX_CONSECUTIVE_LOSSES) {
      shouldPause = true;
      reason = `${this.consecutiveLosses} consecutive losses`;
    }

    if (shouldPause) {
      this.pauseBot(reason);
    }
  }

  private pauseBot(reason: string) {
    const state: CircuitBreakerState = {
      paused: true,
      reason,
      pausedAt: Date.now(),
      resumeAt: Date.now() + this.PAUSE_DURATION_MS,
      losses: this.consecutiveLosses,
    };

    writeFileSync(CIRCUIT_BREAKER_FILE, JSON.stringify(state, null, 2));

    console.log(`\n🚨 CIRCUIT BREAKER TRIGGERED`);
    console.log(`   Reason: ${reason}`);
    console.log(`   Paused for: ${this.PAUSE_DURATION_MS / 60000} minutes`);
    console.log(`   File: ${CIRCUIT_BREAKER_FILE}\n`);

    // Auto-resume after pause duration
    setTimeout(() => {
      this.resumeBot();
    }, this.PAUSE_DURATION_MS);
  }

  private resumeBot() {
    const state: CircuitBreakerState = {
      paused: false,
      reason: "Auto-resumed after pause duration",
      losses: 0,
    };

    writeFileSync(CIRCUIT_BREAKER_FILE, JSON.stringify(state, null, 2));
    this.consecutiveLosses = 0; // Reset

    console.log(`\n✅ CIRCUIT BREAKER RESET - Bot can resume`);
    console.log(`   File: ${CIRCUIT_BREAKER_FILE}\n`);
  }

  private calculateWindow(durationMs: number): PnLWindow {
    const now = Date.now();
    const cutoff = now - durationMs;
    const windowSnapshots = this.snapshots.filter((s) => s.timestamp >= cutoff);

    if (windowSnapshots.length === 0) {
      return {
        period: this.formatDuration(durationMs),
        startBalance: this.startBalance,
        currentBalance: this.lastBalance,
        pnl: 0,
        pnlPercent: 0,
        transactions: 0,
        wins: 0,
        losses: 0,
        winRate: 0,
        avgFeePerTx: 0,
      };
    }

    const startBalance = windowSnapshots[0].balance;
    const currentBalance = this.lastBalance;
    const pnl = currentBalance - startBalance;
    const pnlPercent = (pnl / startBalance) * 100;

    const wins = windowSnapshots.filter((s) => s.type === "sell").length;
    const losses = windowSnapshots.filter((s) => s.type === "buy").length;
    const transactions = wins + losses;
    const winRate = transactions > 0 ? (wins / transactions) * 100 : 0;

    const fees = windowSnapshots
      .filter((s) => s.type === "buy")
      .reduce((sum, s, i, arr) => {
        if (i > 0) {
          const change = s.balance - arr[i - 1].balance;
          return sum + Math.abs(change);
        }
        return sum;
      }, 0);

    return {
      period: this.formatDuration(durationMs),
      startBalance,
      currentBalance,
      pnl,
      pnlPercent,
      transactions,
      wins,
      losses,
      winRate,
      avgFeePerTx: transactions > 0 ? fees / transactions : 0,
    };
  }

  private formatDuration(ms: number): string {
    if (ms < 60000) return `${ms / 1000}s`;
    if (ms < 3600000) return `${ms / 60000}m`;
    return `${ms / 3600000}h`;
  }

  private report() {
    const window30s = this.calculateWindow(30000);
    const current = this.lastBalance;
    const totalPnl = current - this.startBalance;
    const totalPnlPercent = (totalPnl / this.startBalance) * 100;

    console.log(`\n⏱️  30s Window:`);
    console.log(`   PnL: ${window30s.pnl >= 0 ? "+" : ""}${window30s.pnl.toFixed(6)} SOL (${window30s.pnlPercent.toFixed(2)}%)`);
    console.log(`   Txs: ${window30s.transactions} | Win Rate: ${window30s.winRate.toFixed(1)}%`);
    console.log(`   Total PnL: ${totalPnl >= 0 ? "+" : ""}${totalPnl.toFixed(6)} SOL (${totalPnlPercent.toFixed(2)}%)`);
  }

  private detailedReport() {
    const window30s = this.calculateWindow(30000);
    const window5m = this.calculateWindow(300000);
    const window1h = this.calculateWindow(3600000);

    const current = this.lastBalance;
    const totalPnl = current - this.startBalance;
    const totalPnlPercent = (totalPnl / this.startBalance) * 100;

    console.log(`\n📊 DETAILED PNL REPORT`);
    console.log(`=====================`);
    console.log(`Session Start: ${this.startBalance.toFixed(6)} SOL`);
    console.log(`Current: ${current.toFixed(6)} SOL`);
    console.log(`Total PnL: ${totalPnl >= 0 ? "+" : ""}${totalPnl.toFixed(6)} SOL (${totalPnlPercent.toFixed(2)}%)`);
    console.log(``);
    console.log(`Transactions: ${this.txCount}`);
    console.log(`Wins: ${this.winCount} | Losses: ${this.lossCount}`);
    console.log(`Win Rate: ${this.txCount > 0 ? ((this.winCount / this.txCount) * 100).toFixed(1) : 0}%`);
    console.log(`Total Fees: ${this.totalFees.toFixed(6)} SOL`);
    console.log(``);

    const printWindow = (w: PnLWindow) => {
      console.log(`${w.period}:`);
      console.log(`  PnL: ${w.pnl >= 0 ? "+" : ""}${w.pnl.toFixed(6)} SOL (${w.pnlPercent.toFixed(2)}%)`);
      console.log(`  Txs: ${w.transactions} | Wins: ${w.wins} | Losses: ${w.losses}`);
      console.log(`  Win Rate: ${w.winRate.toFixed(1)}% | Avg Fee: ${w.avgFeePerTx.toFixed(6)} SOL`);
    };

    printWindow(window30s);
    printWindow(window5m);
    printWindow(window1h);

    console.log(``);
    console.log(`Circuit Breaker: ${this.consecutiveLosses}/${this.MAX_CONSECUTIVE_LOSSES} consecutive losses`);
    console.log(`===================\n`);
  }
}

// Check if bot should be paused
export function isBotPaused(): boolean {
  if (!existsSync(CIRCUIT_BREAKER_FILE)) return false;
  
  try {
    const state: CircuitBreakerState = JSON.parse(readFileSync(CIRCUIT_BREAKER_FILE, "utf-8"));
    if (!state.paused) return false;
    
    // Check if pause expired
    if (state.resumeAt && Date.now() > state.resumeAt) {
      return false; // Pause expired
    }
    
    return true;
  } catch {
    return false;
  }
}

async function main() {
  const monitor = new PnLMonitor();
  await monitor.start();

  // Keep alive
  await new Promise(() => {});
}

process.on("SIGINT", () => {
  console.log("\n📊 PNL Monitor shutting down...");
  process.exit(0);
});

main().catch(console.error);

