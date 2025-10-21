/**
 * Pump.fun Transaction Builders
 * 
 * Constructs buy and sell transactions for the Pump.fun bonding curve program.
 * 
 * Program: 6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P
 * 
 * Transaction structure:
 * 1. Compute budget instructions (units + priority fee)
 * 2. Create associated token account (idempotent)
 * 3. Buy/Sell instruction with amount and slippage protection
 * 
 * All PDAs are derived deterministically using program seeds.
 */

import {
  ComputeBudgetProgram,
  Connection,
  Keypair,
  PublicKey,
  SystemProgram,
  Transaction,
  TransactionInstruction,
} from "@solana/web3.js";
import {
  ASSOCIATED_TOKEN_PROGRAM_ID,
  BUY_DISCRIMINATOR,
  DEFAULT_COMPUTE_UNITS,
  LAMPORTS_PER_SOL,
  PUMP_EVENT_AUTHORITY,
  PUMP_FEE_RECIPIENT,
  PUMP_FEE_PROGRAM,
  PUMP_GLOBAL,
  PUMP_PROGRAM_ID,
  SELL_DISCRIMINATOR,
  SYSTEM_PROGRAM_ID,
  TOKEN_DECIMALS,
  TOKEN_PROGRAM_ID,
} from "./constants";
import { 
  deriveAssociatedBondingCurvePDA, 
  deriveAssociatedTokenAddress, 
  deriveBondingCurvePDA,
  deriveCreatorVaultPDA,
  deriveFeeConfigPDA,
  deriveGlobalVolumeAccumulatorPDA,
  deriveUserVolumeAccumulatorPDA,
} from "./pdas";

export interface BuyTransactionParams {
  connection: Connection;
  buyer: PublicKey;
  mint: PublicKey;
  creator: PublicKey; // Pass creator from transaction, don't fetch!
  amountSol: number;
  slippageBps: number;
  priorityFeeLamports?: number;
  computeUnits?: number;
  blockhash?: string; // Optional: pass blockhash from stream to avoid RPC call
}

export interface SellTransactionParams {
  connection: Connection;
  seller: PublicKey;
  mint: PublicKey;
  creator: PublicKey; // Pass creator, don't fetch!
  tokenAmount: number;
  slippageBps: number;
  priorityFeeLamports?: number;
  computeUnits?: number;
}

export interface BuildTransactionResult {
  transaction: Transaction;
  metadata: {
    mint: string;
    amount: number;
    slippageBps: number;
    estimatedFee: number;
  };
}

/**
 * Builds a Pump.fun buy transaction.
 * Creates associated token account if needed, then executes buy instruction.
 */
export async function buildBuyTransaction(params: BuyTransactionParams): Promise<BuildTransactionResult> {
  const { connection, buyer, mint, creator, amountSol, slippageBps, priorityFeeLamports = 10000, computeUnits = DEFAULT_COMPUTE_UNITS, blockhash } = params;

  const transaction = new Transaction();

  // Add compute budget instructions
  transaction.add(
    ComputeBudgetProgram.setComputeUnitLimit({
      units: computeUnits,
    }),
  );

  if (priorityFeeLamports > 0) {
    transaction.add(
      ComputeBudgetProgram.setComputeUnitPrice({
        microLamports: priorityFeeLamports,
      }),
    );
  }

  // Derive all required PDAs (16 accounts for BUY)
  const [bondingCurve] = deriveBondingCurvePDA(mint);
  const associatedBondingCurve = deriveAssociatedBondingCurvePDA(mint);
  const buyerTokenAccount = deriveAssociatedTokenAddress(buyer, mint, TOKEN_PROGRAM_ID);
  
  // Creator-specific PDA
  const [creatorVault] = deriveCreatorVaultPDA(creator);
  
  // Volume and fee tracking PDAs
  const [globalVolumeAccumulator] = deriveGlobalVolumeAccumulatorPDA();
  const [userVolumeAccumulator] = deriveUserVolumeAccumulatorPDA(buyer);
  const [feeConfig] = deriveFeeConfigPDA();

  // Create associated token account instruction (idempotent)
  const createAtaInstruction = createAssociatedTokenAccountIdempotentInstruction(
    buyer,
    buyerTokenAccount,
    buyer,
    mint,
  );
  transaction.add(createAtaInstruction);

  // Build buy instruction
  // Request large token amount (100k tokens = 100,000,000,000 with 6 decimals)
  // The actual amount will be limited by maxSolCost
  const tokenAmount = BigInt(100_000_000_000); // 100k tokens
  const maxSolCost = BigInt(Math.floor((amountSol * (1 + slippageBps / 10000)) * LAMPORTS_PER_SOL));

  const buyInstruction = createBuyInstruction({
    buyer,
    mint,
    bondingCurve,
    associatedBondingCurve,
    buyerTokenAccount,
    creatorVault,
    globalVolumeAccumulator,
    userVolumeAccumulator,
    feeConfig,
    tokenAmount, // Request 100k tokens
    maxSolCost, // Limit spend to actual SOL amount
  });

  transaction.add(buyInstruction);

  // Get recent blockhash (use cached if provided, otherwise fetch)
  if (blockhash) {
    transaction.recentBlockhash = blockhash;
  } else {
    const { blockhash: fetchedHash, lastValidBlockHeight } = await connection.getLatestBlockhash("finalized");
    transaction.recentBlockhash = fetchedHash;
    transaction.lastValidBlockHeight = lastValidBlockHeight;
  }
  transaction.feePayer = buyer;

  return {
    transaction,
    metadata: {
      mint: mint.toBase58(),
      amount: amountSol,
      slippageBps,
      estimatedFee: priorityFeeLamports / LAMPORTS_PER_SOL,
    },
  };
}

/**
 * Builds a Pump.fun sell transaction.
 */
export async function buildSellTransaction(params: SellTransactionParams): Promise<BuildTransactionResult> {
  const { connection, seller, mint, creator, tokenAmount, slippageBps, priorityFeeLamports = 10000, computeUnits = DEFAULT_COMPUTE_UNITS } = params;

  const transaction = new Transaction();

  // Add compute budget instructions
  transaction.add(
    ComputeBudgetProgram.setComputeUnitLimit({
      units: computeUnits,
    }),
  );

  if (priorityFeeLamports > 0) {
    transaction.add(
      ComputeBudgetProgram.setComputeUnitPrice({
        microLamports: priorityFeeLamports,
      }),
    );
  }

  // Derive PDAs - NO RPC CALLS!
  const [bondingCurve] = deriveBondingCurvePDA(mint);
  const associatedBondingCurve = deriveAssociatedBondingCurvePDA(mint);
  const sellerTokenAccount = deriveAssociatedTokenAddress(seller, mint, TOKEN_PROGRAM_ID);
  
  // Use creator passed from params (same one from buy)
  const [creatorVault] = deriveCreatorVaultPDA(creator);
  const [globalVolumeAccumulator] = deriveGlobalVolumeAccumulatorPDA();
  const [userVolumeAccumulator] = deriveUserVolumeAccumulatorPDA(seller);
  const [feeConfig] = deriveFeeConfigPDA();

  // Build sell instruction (14 accounts - no volume tracking in instruction itself)
  const tokenAmountRaw = BigInt(Math.floor(tokenAmount * 10 ** TOKEN_DECIMALS));
  const minSolOutput = BigInt(0);

  const sellInstruction = createSellInstruction({
    seller,
    mint,
    bondingCurve,
    associatedBondingCurve,
    sellerTokenAccount,
    creatorVault,
    feeConfig,
    tokenAmountRaw,
    minSolOutput,
  });

  transaction.add(sellInstruction);

  // Get recent blockhash
  const { blockhash, lastValidBlockHeight } = await connection.getLatestBlockhash("finalized");
  transaction.recentBlockhash = blockhash;
  transaction.lastValidBlockHeight = lastValidBlockHeight;
  transaction.feePayer = seller;

  return {
    transaction,
    metadata: {
      mint: mint.toBase58(),
      amount: tokenAmount,
      slippageBps,
      estimatedFee: priorityFeeLamports / LAMPORTS_PER_SOL,
    },
  };
}

/**
 * Creates a buy instruction for Pump.fun
 * 
 * Account order matches Pump.fun program requirements (16 accounts total):
 * 0. global, 1. fee_recipient, 2. mint, 3. bonding_curve, 4. associated_bonding_curve,
 * 5. buyer_token_account, 6. buyer (signer), 7. system_program, 8. token_program,
 * 9. creator_vault, 10. event_authority, 11. program, 12. global_volume_accumulator,
 * 13. user_volume_accumulator, 14. fee_config, 15. fee_program
 */
function createBuyInstruction(params: {
  buyer: PublicKey;
  mint: PublicKey;
  bondingCurve: PublicKey;
  associatedBondingCurve: PublicKey;
  buyerTokenAccount: PublicKey;
  creatorVault: PublicKey;
  globalVolumeAccumulator: PublicKey;
  userVolumeAccumulator: PublicKey;
  feeConfig: PublicKey;
  tokenAmount: bigint;
  maxSolCost: bigint;
}): TransactionInstruction {
  const {
    buyer, mint, bondingCurve, associatedBondingCurve, buyerTokenAccount,
    creatorVault, globalVolumeAccumulator, userVolumeAccumulator, feeConfig,
    tokenAmount, maxSolCost 
  } = params;

  // Instruction data: discriminator + token_amount + max_sol_cost
  const data = Buffer.alloc(24);
  BUY_DISCRIMINATOR.copy(data, 0);
  data.writeBigUInt64LE(tokenAmount, 8);
  data.writeBigUInt64LE(maxSolCost, 16);

  // 16 accounts matching Python working bot
  return new TransactionInstruction({
    keys: [
      { pubkey: PUMP_GLOBAL, isSigner: false, isWritable: false }, // 0. global
      { pubkey: PUMP_FEE_RECIPIENT, isSigner: false, isWritable: true }, // 1. fee_recipient
      { pubkey: mint, isSigner: false, isWritable: false }, // 2. mint
      { pubkey: bondingCurve, isSigner: false, isWritable: true }, // 3. bonding_curve
      { pubkey: associatedBondingCurve, isSigner: false, isWritable: true }, // 4. associated_bonding_curve
      { pubkey: buyerTokenAccount, isSigner: false, isWritable: true }, // 5. user_token_account
      { pubkey: buyer, isSigner: true, isWritable: true }, // 6. user (signer)
      { pubkey: SYSTEM_PROGRAM_ID, isSigner: false, isWritable: false }, // 7. system_program
      { pubkey: TOKEN_PROGRAM_ID, isSigner: false, isWritable: false }, // 8. token_program
      { pubkey: creatorVault, isSigner: false, isWritable: true }, // 9. creator_vault
      { pubkey: PUMP_EVENT_AUTHORITY, isSigner: false, isWritable: false }, // 10. event_authority
      { pubkey: PUMP_PROGRAM_ID, isSigner: false, isWritable: false }, // 11. program
      { pubkey: globalVolumeAccumulator, isSigner: false, isWritable: true }, // 12. global_volume_accumulator
      { pubkey: userVolumeAccumulator, isSigner: false, isWritable: true }, // 13. user_volume_accumulator
      { pubkey: feeConfig, isSigner: false, isWritable: false }, // 14. fee_config
      { pubkey: PUMP_FEE_PROGRAM, isSigner: false, isWritable: false }, // 15. fee_program
    ],
    programId: PUMP_PROGRAM_ID,
    data,
  });
}

/**
 * Creates a sell instruction for Pump.fun
 * 
 * SELL has 14 accounts (NO volume tracking, creator_vault BEFORE token_program):
 * 0. global, 1. fee_recipient, 2. mint, 3. bonding_curve, 4. associated_bonding_curve,
 * 5. seller_token_account, 6. seller (signer), 7. system_program,  
 * 8. creator_vault, 9. token_program, 10. event_authority, 11. program,
 * 12. fee_config, 13. fee_program
 */
function createSellInstruction(params: {
  seller: PublicKey;
  mint: PublicKey;
  bondingCurve: PublicKey;
  associatedBondingCurve: PublicKey;
  sellerTokenAccount: PublicKey;
  creatorVault: PublicKey;
  feeConfig: PublicKey;
  tokenAmountRaw: bigint;
  minSolOutput: bigint;
}): TransactionInstruction {
  const { 
    seller, mint, bondingCurve, associatedBondingCurve, sellerTokenAccount,
    creatorVault, feeConfig,
    tokenAmountRaw, minSolOutput 
  } = params;

  // Instruction data: discriminator + amount + min_sol_output
  const data = Buffer.alloc(24);
  SELL_DISCRIMINATOR.copy(data, 0);
  data.writeBigUInt64LE(tokenAmountRaw, 8);
  data.writeBigUInt64LE(minSolOutput, 16);

  // 14 accounts matching Python working bot (creator_vault at position 8, BEFORE token_program)
  return new TransactionInstruction({
    keys: [
      { pubkey: PUMP_GLOBAL, isSigner: false, isWritable: false }, // 0. global
      { pubkey: PUMP_FEE_RECIPIENT, isSigner: false, isWritable: true }, // 1. fee_recipient
      { pubkey: mint, isSigner: false, isWritable: false }, // 2. mint
      { pubkey: bondingCurve, isSigner: false, isWritable: true }, // 3. bonding_curve
      { pubkey: associatedBondingCurve, isSigner: false, isWritable: true }, // 4. associated_bonding_curve
      { pubkey: sellerTokenAccount, isSigner: false, isWritable: true }, // 5. user_token_account
      { pubkey: seller, isSigner: true, isWritable: true }, // 6. user (signer)
      { pubkey: SYSTEM_PROGRAM_ID, isSigner: false, isWritable: false }, // 7. system_program
      { pubkey: creatorVault, isSigner: false, isWritable: true }, // 8. creator_vault (BEFORE token_program!)
      { pubkey: TOKEN_PROGRAM_ID, isSigner: false, isWritable: false }, // 9. token_program
      { pubkey: PUMP_EVENT_AUTHORITY, isSigner: false, isWritable: false }, // 10. event_authority
      { pubkey: PUMP_PROGRAM_ID, isSigner: false, isWritable: false }, // 11. program
      { pubkey: feeConfig, isSigner: false, isWritable: false }, // 12. fee_config
      { pubkey: PUMP_FEE_PROGRAM, isSigner: false, isWritable: false }, // 13. fee_program
    ],
    programId: PUMP_PROGRAM_ID,
    data,
  });
}

/**
 * Creates an idempotent associated token account creation instruction
 */
function createAssociatedTokenAccountIdempotentInstruction(
  payer: PublicKey,
  associatedToken: PublicKey,
  owner: PublicKey,
  mint: PublicKey,
): TransactionInstruction {
  return new TransactionInstruction({
    keys: [
      { pubkey: payer, isSigner: true, isWritable: true },
      { pubkey: associatedToken, isSigner: false, isWritable: true },
      { pubkey: owner, isSigner: false, isWritable: false },
      { pubkey: mint, isSigner: false, isWritable: false },
      { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
      { pubkey: TOKEN_PROGRAM_ID, isSigner: false, isWritable: false },
    ],
    programId: ASSOCIATED_TOKEN_PROGRAM_ID,
    data: Buffer.from([0x01]), // CreateIdempotent discriminator
  });
}

