import type { Connection, Keypair, Transaction } from "@solana/web3.js";
import type { FreshSniperConfig } from "@fresh-sniper/config";
import type { Logger } from "@fresh-sniper/logging";
import type { MetricsClient } from "@fresh-sniper/metrics";
import { PublicKey } from "@solana/web3.js";
import { buildBuyTransaction, buildSellTransaction, type BuildTransactionResult } from "./pumpfun/builders";

interface WorkflowDeps {
  config: FreshSniperConfig;
  logger: Logger;
  metrics: MetricsClient;
  connection: Connection;
  trader: Keypair;
}

export interface BuyPayload {
  mint: string;
  amountSol?: number;
  slippageBps?: number;
}

export interface SellPayload {
  mint: string;
  tokenAmount: number;
  slippageBps?: number;
}

export interface WorkflowResult {
  success: boolean;
  signature: string | null;
  error?: string;
  metrics: Record<string, unknown>;
}

export interface Workflow<TPayload> {
  execute(payload: TPayload): Promise<WorkflowResult>;
}

/**
 * Creates a buy workflow that builds, simulates, and optionally sends a buy transaction.
 */
export function buildBuyWorkflow(deps: WorkflowDeps): Workflow<BuyPayload> {
  return {
    async execute(payload) {
      const startTime = Date.now();
      const { config, logger, metrics, connection, trader } = deps;

      try {
        const mint = new PublicKey(payload.mint);
        const amountSol = payload.amountSol ?? config.strategy.buy_amount_sol;
        const slippageBps = payload.slippageBps ?? config.strategy.max_slippage_bps;

        logger.info({ mint: payload.mint, amountSol, slippageBps }, "building buy transaction");

        // Build transaction
        const buildStart = Date.now();
        const { transaction, metadata } = await buildBuyTransaction({
          connection,
          buyer: trader.publicKey,
          mint,
          creator: trader.publicKey, // Fallback for hot-route (doesn't have stream context)
          amountSol,
          slippageBps,
          priorityFeeLamports: config.jito.priority_fee_lamports,
        });
        const buildTimeMs = Date.now() - buildStart;
        metrics.observeLatency("transaction_build_ms", buildTimeMs);

        // Simulate if enabled
        let simulateTimeMs = 0;
        if (config.simulation.enabled) {
          const simulateStart = Date.now();
          const simulation = await connection.simulateTransaction(transaction);
          simulateTimeMs = Date.now() - simulateStart;
          metrics.observeLatency("transaction_simulate_ms", simulateTimeMs);

          if (simulation.value.err) {
            logger.error({ err: simulation.value.err, mint: payload.mint }, "buy simulation failed");
            metrics.incrementCounter("buy_simulation_failures");
            return {
              success: false,
              signature: null,
              error: `Simulation failed: ${JSON.stringify(simulation.value.err)}`,
              metrics: { buildTimeMs, simulateTimeMs, simulated: true },
            };
          }

          logger.debug({ mint: payload.mint, logs: simulation.value.logs }, "buy simulation succeeded");
        }

        // TODO: Actually send transaction via Jito or RPC
        // For now, return success with build/simulate metrics
        const totalTimeMs = Date.now() - startTime;

        metrics.incrementCounter("buy_transactions_built");
        logger.info({ mint: payload.mint, buildTimeMs, simulateTimeMs, totalTimeMs }, "buy workflow completed");

        return {
          success: true,
          signature: null, // TODO: return actual signature after sending
          metrics: {
            buildTimeMs,
            simulateTimeMs,
            totalTimeMs,
            simulated: config.simulation.enabled,
            ...metadata,
          },
        };
      } catch (error) {
        const errorMessage = error instanceof Error ? error.message : String(error);
        logger.error({ err: errorMessage, mint: payload.mint }, "buy workflow failed");
        metrics.incrementCounter("buy_workflow_errors");

        return {
          success: false,
          signature: null,
          error: errorMessage,
          metrics: { totalTimeMs: Date.now() - startTime },
        };
      }
    },
  };
}

/**
 * Creates a sell workflow that builds, simulates, and optionally sends a sell transaction.
 */
export function buildSellWorkflow(deps: WorkflowDeps): Workflow<SellPayload> {
  return {
    async execute(payload) {
      const startTime = Date.now();
      const { config, logger, metrics, connection, trader } = deps;

      try {
        const mint = new PublicKey(payload.mint);
        const tokenAmount = payload.tokenAmount;
        const slippageBps = payload.slippageBps ?? config.strategy.max_slippage_bps;

        logger.info({ mint: payload.mint, tokenAmount, slippageBps }, "building sell transaction");

        // Build transaction
        const buildStart = Date.now();
        const { transaction, metadata } = await buildSellTransaction({
          connection,
          seller: trader.publicKey,
          mint,
          tokenAmount,
          slippageBps,
          priorityFeeLamports: config.jito.priority_fee_lamports,
        });
        const buildTimeMs = Date.now() - buildStart;
        metrics.observeLatency("transaction_build_ms", buildTimeMs);

        // Simulate if enabled
        let simulateTimeMs = 0;
        if (config.simulation.enabled) {
          const simulateStart = Date.now();
          const simulation = await connection.simulateTransaction(transaction);
          simulateTimeMs = Date.now() - simulateStart;
          metrics.observeLatency("transaction_simulate_ms", simulateTimeMs);

          if (simulation.value.err) {
            logger.error({ err: simulation.value.err, mint: payload.mint }, "sell simulation failed");
            metrics.incrementCounter("sell_simulation_failures");
            return {
              success: false,
              signature: null,
              error: `Simulation failed: ${JSON.stringify(simulation.value.err)}`,
              metrics: { buildTimeMs, simulateTimeMs, simulated: true },
            };
          }

          logger.debug({ mint: payload.mint, logs: simulation.value.logs }, "sell simulation succeeded");
        }

        // TODO: Actually send transaction via Jito or RPC
        const totalTimeMs = Date.now() - startTime;

        metrics.incrementCounter("sell_transactions_built");
        logger.info({ mint: payload.mint, buildTimeMs, simulateTimeMs, totalTimeMs }, "sell workflow completed");

        return {
          success: true,
          signature: null, // TODO: return actual signature after sending
          metrics: {
            buildTimeMs,
            simulateTimeMs,
            totalTimeMs,
            simulated: config.simulation.enabled,
            ...metadata,
          },
        };
      } catch (error) {
        const errorMessage = error instanceof Error ? error.message : String(error);
        logger.error({ err: errorMessage, mint: payload.mint }, "sell workflow failed");
        metrics.incrementCounter("sell_workflow_errors");

        return {
          success: false,
          signature: null,
          error: errorMessage,
          metrics: { totalTimeMs: Date.now() - startTime },
        };
      }
    },
  };
}

