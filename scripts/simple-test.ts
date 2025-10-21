import "dotenv/config";
import bs58 from "bs58";
import {
  Connection,
  Keypair,
  PublicKey,
  Transaction,
  SystemProgram,
  TransactionInstruction,
  ComputeBudgetProgram,
  LAMPORTS_PER_SOL,
  AccountInfo,
} from "@solana/web3.js";
import {
  TOKEN_PROGRAM_ID,
  getAssociatedTokenAddressSync,
  createAssociatedTokenAccountInstruction,
  createCloseAccountInstruction,
} from "@solana/spl-token";
import Client, {
  CommitmentLevel,
} from "@triton-one/yellowstone-grpc";
import BN from "bn.js";

// Test configuration
const TEST_DURATION_MS = 15 * 60 * 1000; // 15 minutes
const BUY_AMOUNT = 0.015; // 0.015 SOL per buy
const SELL_DELAY_MS = 3000; // 3 seconds
const BUY_COOLDOWN_MS = 20000; // 20 seconds between buys
const MIN_BALANCE_SOL = 0.05; // Stop if balance drops below this

const CONFIG = {
  PUMP_PROGRAM: new PublicKey("6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P"),
  PUMP_TOKEN_PROGRAM: "TSLvdd1pWpHVjahSpsvCXUbgwsL3JAcvokwaKt1eokM",
  PUMP_GLOBAL: new PublicKey("4wTV1YmiEkRvAtNtsSGPtUrqRYQMe5SKy2uB4Jjaxnjf"),
  PUMP_FEE_RECIPIENT: new PublicKey("CebN5WGQ4jvEPvsVU4EoHEpgzq1VV7AbicfhtW4xC9iM"),
  PUMP_EVENT_AUTHORITY: new PublicKey("Ce6TQqeHC9p8KetsN6JsjHK7UTZk7nasjjnr7XxXp9F1"),
  PUMP_FEE_PROGRAM: new PublicKey("pfeeUxB6jkeY1Hxd7CsFCAjcbHA9rWtchMGdZ6VojVZ"),
  COMPUTE_UNITS: 250000,
};

const DISCRIMINATORS = {
  BUY: Buffer.from([0x66, 0x06, 0x3d, 0x12, 0x01, 0xda, 0xeb, 0xea]),
  SELL: Buffer.from([0x33, 0xe6, 0x85, 0xa4, 0x01, 0x7f, 0x83, 0xad]),
};

// State tracking
let latestBlockhash: string | null = null;
const processedMints = new Set<string>();
let lastBuyTime = 0;
let tokensDetected = 0;
let buyAttempts = 0;
let startTime = Date.now();

// PDA derivation helpers
function findCreatorVault(creator: PublicKey): PublicKey {
  const [pda] = PublicKey.findProgramAddressSync(
    [Buffer.from("creator-vault"), creator.toBuffer()],
    CONFIG.PUMP_PROGRAM,
  );
  return pda;
}

function findGlobalVolumeAccumulator(): PublicKey {
  const [pda] = PublicKey.findProgramAddressSync(
    [Buffer.from("global_volume_accumulator")],
    CONFIG.PUMP_PROGRAM,
  );
  return pda;
}

function findUserVolumeAccumulator(user: PublicKey): PublicKey {
  const [pda] = PublicKey.findProgramAddressSync(
    [Buffer.from("user_volume_accumulator"), user.toBuffer()],
    CONFIG.PUMP_PROGRAM,
  );
  return pda;
}

function findFeeConfig(): PublicKey {
  const constant = Buffer.from([
    1, 86, 224, 246, 147, 102, 90, 207, 68, 219, 21, 104, 191, 23, 91, 170, 81,
    137, 203, 151, 245, 210, 255, 59, 101, 93, 43, 182, 253, 109, 24, 176,
  ]);
  const [pda] = PublicKey.findProgramAddressSync(
    [Buffer.from("fee_config"), constant],
    CONFIG.PUMP_FEE_PROGRAM,
  );
  return pda;
}

function buildBuyTx(
  wallet: Keypair,
  mint: PublicKey,
  creator: PublicKey,
  priorityFee: number,
  blockhash: string,
): Transaction {
  const tx = new Transaction();

  tx.add(ComputeBudgetProgram.setComputeUnitLimit({ units: CONFIG.COMPUTE_UNITS }));
  tx.add(ComputeBudgetProgram.setComputeUnitPrice({ microLamports: priorityFee }));

  const [bondingCurve] = PublicKey.findProgramAddressSync(
    [Buffer.from("bonding-curve"), mint.toBuffer()],
    CONFIG.PUMP_PROGRAM,
  );

  const associatedBondingCurve = getAssociatedTokenAddressSync(mint, bondingCurve, true);
  const buyerAta = getAssociatedTokenAddressSync(mint, wallet.publicKey);

  const creatorVault = findCreatorVault(creator);
  const globalVolumeAccumulator = findGlobalVolumeAccumulator();
  const userVolumeAccumulator = findUserVolumeAccumulator(wallet.publicKey);
  const feeConfig = findFeeConfig();

  tx.add(
    createAssociatedTokenAccountInstruction(
      wallet.publicKey,
      buyerAta,
      wallet.publicKey,
      mint,
    ),
  );

  const tokenAmount = BigInt("100000000000");
  const maxSolCost = Math.floor(BUY_AMOUNT * LAMPORTS_PER_SOL);

  tx.add(
    new TransactionInstruction({
      programId: CONFIG.PUMP_PROGRAM,
      keys: [
        { pubkey: CONFIG.PUMP_GLOBAL, isSigner: false, isWritable: false },
        { pubkey: CONFIG.PUMP_FEE_RECIPIENT, isSigner: false, isWritable: true },
        { pubkey: mint, isSigner: false, isWritable: false },
        { pubkey: bondingCurve, isSigner: false, isWritable: true },
        { pubkey: associatedBondingCurve, isSigner: false, isWritable: true },
        { pubkey: buyerAta, isSigner: false, isWritable: true },
        { pubkey: wallet.publicKey, isSigner: true, isWritable: true },
        { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
        { pubkey: TOKEN_PROGRAM_ID, isSigner: false, isWritable: false },
        { pubkey: creatorVault, isSigner: false, isWritable: true },
        { pubkey: CONFIG.PUMP_EVENT_AUTHORITY, isSigner: false, isWritable: false },
        { pubkey: CONFIG.PUMP_PROGRAM, isSigner: false, isWritable: false },
        { pubkey: globalVolumeAccumulator, isSigner: false, isWritable: true },
        { pubkey: userVolumeAccumulator, isSigner: false, isWritable: true },
        { pubkey: feeConfig, isSigner: false, isWritable: false },
        { pubkey: CONFIG.PUMP_FEE_PROGRAM, isSigner: false, isWritable: false },
      ],
      data: Buffer.concat([
        DISCRIMINATORS.BUY,
        Buffer.from(new BN(tokenAmount.toString()).toArray("le", 8)),
        Buffer.from(new BN(maxSolCost).toArray("le", 8)),
        Buffer.from([0]),
      ]),
    }),
  );

  tx.recentBlockhash = blockhash;
  tx.feePayer = wallet.publicKey;
  return tx;
}

function buildSellTx(
  wallet: Keypair,
  mint: PublicKey,
  creator: PublicKey,
  tokenAmount: bigint,
  priorityFee: number,
  blockhash: string,
): Transaction {
  const tx = new Transaction();

  tx.add(ComputeBudgetProgram.setComputeUnitLimit({ units: CONFIG.COMPUTE_UNITS }));
  tx.add(ComputeBudgetProgram.setComputeUnitPrice({ microLamports: priorityFee }));

  const [bondingCurve] = PublicKey.findProgramAddressSync(
    [Buffer.from("bonding-curve"), mint.toBuffer()],
    CONFIG.PUMP_PROGRAM,
  );

  const associatedBondingCurve = getAssociatedTokenAddressSync(mint, bondingCurve, true);
  const sellerAta = getAssociatedTokenAddressSync(mint, wallet.publicKey);

  const creatorVault = findCreatorVault(creator);
  const globalVolumeAccumulator = findGlobalVolumeAccumulator();
  const userVolumeAccumulator = findUserVolumeAccumulator(wallet.publicKey);
  const feeConfig = findFeeConfig();

  const minSolOutput = 1;

  tx.add(
    new TransactionInstruction({
      programId: CONFIG.PUMP_PROGRAM,
      keys: [
        { pubkey: CONFIG.PUMP_GLOBAL, isSigner: false, isWritable: false },
        { pubkey: CONFIG.PUMP_FEE_RECIPIENT, isSigner: false, isWritable: true },
        { pubkey: mint, isSigner: false, isWritable: false },
        { pubkey: bondingCurve, isSigner: false, isWritable: true },
        { pubkey: associatedBondingCurve, isSigner: false, isWritable: true },
        { pubkey: sellerAta, isSigner: false, isWritable: true },
        { pubkey: wallet.publicKey, isSigner: true, isWritable: true },
        { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
        { pubkey: TOKEN_PROGRAM_ID, isSigner: false, isWritable: false },
        { pubkey: creatorVault, isSigner: false, isWritable: true },
        { pubkey: CONFIG.PUMP_EVENT_AUTHORITY, isSigner: false, isWritable: false },
        { pubkey: CONFIG.PUMP_PROGRAM, isSigner: false, isWritable: false },
        { pubkey: globalVolumeAccumulator, isSigner: false, isWritable: true },
        { pubkey: userVolumeAccumulator, isSigner: false, isWritable: true },
        { pubkey: feeConfig, isSigner: false, isWritable: false },
        { pubkey: CONFIG.PUMP_FEE_PROGRAM, isSigner: false, isWritable: false },
      ],
      data: Buffer.concat([
        DISCRIMINATORS.SELL,
        Buffer.from(new BN(tokenAmount.toString()).toArray("le", 8)),
        Buffer.from(new BN(minSolOutput).toArray("le", 8)),
        Buffer.from([0]),
      ]),
    }),
  );

  tx.recentBlockhash = blockhash;
  tx.feePayer = wallet.publicKey;
  return tx;
}

async function executeSell(
  connection: Connection,
  wallet: Keypair,
  mint: PublicKey,
  creator: PublicKey,
  mintStr: string,
) {
  try {
    const ata = getAssociatedTokenAddressSync(mint, wallet.publicKey);

    let acc: AccountInfo<Buffer> | null = null;
    for (let i = 0; i < 3; i++) {
      acc = await connection.getAccountInfo(ata);
      if (acc) break;
      await new Promise((r) => setTimeout(r, 1000));
    }

    if (!acc || !acc.data || acc.data.length < 72) {
      console.log(`   ❌ No token account`);
      return;
    }

    const amt = acc.data.readBigUInt64LE(64);
    if (amt === BigInt(0)) {
      console.log(`   ❌ Zero balance`);
      return;
    }

    if (!latestBlockhash) {
      console.log(`   ❌ No blockhash`);
      return;
    }

    const sellTx = buildSellTx(wallet, mint, creator, amt, 1, latestBlockhash);
    sellTx.sign(wallet);
    const sellSig = await connection.sendRawTransaction(sellTx.serialize(), {
      skipPreflight: true,
      maxRetries: 0,
    });
    console.log(`   💰 SELL: ${sellSig.slice(0, 16)}...`);
  } catch (e) {
    console.log(`   ❌ Sell error: ${(e as Error).message}`);
  }
}

async function main() {
  const rpcUrl = process.env.SHYFT_RPC_URL!.startsWith("http")
    ? process.env.SHYFT_RPC_URL!
    : `https://${process.env.SHYFT_RPC_URL!}`;
  const connection = new Connection(rpcUrl);
  const trader = Keypair.fromSecretKey(bs58.decode(process.env.WALLET_PRIVATE_KEY!));

  const balance = await connection.getBalance(trader.publicKey);
  console.log(`\n💰 Balance: ${(balance / LAMPORTS_PER_SOL).toFixed(4)} SOL`);
  console.log(`🔧 Test: ${TEST_DURATION_MS / 60000} min, ${BUY_AMOUNT} SOL/buy, ${SELL_DELAY_MS}ms hold, ${BUY_COOLDOWN_MS / 1000}s cooldown\n`);

  const client = new Client(process.env.GRPC_URL!, process.env.X_TOKEN, undefined);
  const stream = await client.subscribe();

  stream.on("data", async (data: any) => {
    try {
      if (data.blockMeta?.blockhash) {
        latestBlockhash = data.blockMeta.blockhash;
      }

      const txn = data.transaction;
      if (txn?.transaction?.meta?.postTokenBalances) {
        const meta = txn.transaction.meta;
        const mintStr = meta.postTokenBalances[0]?.mint;

        if (mintStr && mintStr.endsWith("pump")) {
          tokensDetected++;

          if (processedMints.has(mintStr)) return;

          const now = Date.now();
          if (now > startTime + TEST_DURATION_MS) {
            console.log(`\n⏰ Test complete (15 min)`);
            process.exit(0);
          }

          const timeSinceLastBuy = now - lastBuyTime;
          if (lastBuyTime > 0 && timeSinceLastBuy < BUY_COOLDOWN_MS) {
            return;
          }

          processedMints.add(mintStr);
          const mint = new PublicKey(mintStr);
          console.log(`\n🪙 Token #${tokensDetected}: ${mintStr.slice(0, 8)}...`);

          if (!latestBlockhash) {
            console.log(`   ❌ No blockhash`);
            return;
          }

          const transaction = txn.transaction.transaction;
          const accountKeys = transaction.message?.accountKeys;
          if (!accountKeys || accountKeys.length === 0) {
            console.log(`   ❌ No account keys`);
            return;
          }
          const creator = new PublicKey(accountKeys[0]);

          try {
            buyAttempts++;
            lastBuyTime = now;

            const buyTx = buildBuyTx(trader, mint, creator, 33333, latestBlockhash);
            buyTx.sign(trader);
            const sig = await connection.sendRawTransaction(buyTx.serialize(), {
              skipPreflight: true,
              maxRetries: 0,
            });
            console.log(`   ✅ BUY: ${sig.slice(0, 16)}...`);

            setTimeout(() => executeSell(connection, trader, mint, creator, mintStr), SELL_DELAY_MS);
          } catch (e) {
            console.log(`   ❌ Buy error: ${(e as Error).message}`);
          }
        }
      }
    } catch {}
  });

  const req: any = {
    accounts: {},
    slots: {},
    transactions: {
      pumpfun: {
        vote: false,
        failed: false,
        signature: undefined,
        accountInclude: [CONFIG.PUMP_TOKEN_PROGRAM],
        accountExclude: [],
        accountRequired: [],
      },
    },
    transactionsStatus: {},
    blocks: {},
    blocksMeta: {
      blockmeta: {},
    },
    entry: {},
    accountsDataSlice: [],
    commitment: CommitmentLevel.PROCESSED,
  };

  stream.write(req);
  await new Promise(() => {});
}

main().catch(console.error);
