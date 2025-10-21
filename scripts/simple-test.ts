import "dotenv/config";
import bs58 from "bs58";
import {
  Connection,
  Keypair,
  PublicKey,
  LAMPORTS_PER_SOL,
} from "@solana/web3.js";
import {
  TOKEN_PROGRAM_ID,
  getAssociatedTokenAddressSync,
} from "@solana/spl-token";
import Client, {
  CommitmentLevel,
} from "@triton-one/yellowstone-grpc";
import { buildBuyTransaction, buildSellTransaction } from "@fresh-sniper/transactions";

// Test configuration
const TEST_DURATION_MS = 15 * 60 * 1000; // 15 minutes
const BUY_AMOUNT = 0.015; // 0.015 SOL per buy
const SELL_DELAY_MS = 3000; // 3 seconds
const BUY_COOLDOWN_MS = 20000; // 20 seconds between buys
const MIN_BALANCE_SOL = 0.05; // Stop if balance drops below this
const BUY_PRIORITY_FEE = 5000000; // 5M microLamports for reliable landing

const CONFIG = {
  PUMP_PROGRAM: new PublicKey("6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P"),
  PUMP_TOKEN_PROGRAM: new PublicKey("TSLvdd1pWpHVjahSpsvCXUbgwsL3JAcvokwaKt1eokM"),
};

// State tracking
let cachedBlockhash: string | null = null;
const processedMints = new Set<string>();
let lastBuyTime = 0;
let tokensDetected = 0;
let buyAttempts = 0;
let startTime = Date.now();

async function buyToken(
  connection: Connection,
  trader: Keypair,
  mintStr: string,
  creatorStr: string,
) {
  try {
    const mint = new PublicKey(mintStr);
    const creator = new PublicKey(creatorStr);

    if (!cachedBlockhash) {
      console.log(`   ❌ No blockhash`);
      return;
    }

    const { transaction } = await buildBuyTransaction({
      connection,
      buyer: trader.publicKey,
      mint,
      creator,
      amountSol: BUY_AMOUNT,
      slippageBps: 500, // 5% slippage
      priorityFeeLamports: BUY_PRIORITY_FEE,
      computeUnits: 250000,
      blockhash: cachedBlockhash,
    });

    transaction.sign(trader);

    const sig = await connection.sendRawTransaction(transaction.serialize(), {
      skipPreflight: true,
      maxRetries: 0,
    });
    console.log(`   ✅ BUY: ${sig.slice(0, 16)}...`);

    // Schedule sell
    setTimeout(() => sellToken(connection, trader, mintStr, creatorStr), SELL_DELAY_MS);
  } catch (error) {
    console.log(`   ❌ Buy error: ${(error as Error).message}`);
  }
}

async function sellToken(
  connection: Connection,
  trader: Keypair,
  mintStr: string,
  creatorStr: string,
) {
  try {
    const mint = new PublicKey(mintStr);
    const creator = new PublicKey(creatorStr);
    const ata = getAssociatedTokenAddressSync(mint, trader.publicKey);

    // Get token balance
    const accountInfo = await connection.getAccountInfo(ata);
    if (!accountInfo || accountInfo.data.length < 72) {
      console.log(`   ❌ No token account`);
      return;
    }

    const balance = accountInfo.data.readBigUInt64LE(64);
    if (balance === BigInt(0)) {
      console.log(`   ❌ Zero balance`);
      return;
    }

    const tokenAmount = Number(balance) / 1_000_000; // Convert from raw to token amount

    const { transaction } = await buildSellTransaction({
      connection,
      seller: trader.publicKey,
      mint,
      creator,
      tokenAmount,
      slippageBps: 3000, // 30% slippage for quick sell
      priorityFeeLamports: 1, // Minimal fee
      computeUnits: 250000,
    });

    transaction.sign(trader);

    const sig = await connection.sendRawTransaction(transaction.serialize(), {
      skipPreflight: true,
      maxRetries: 0,
    });

    console.log(`   💰 SELL: ${sig.slice(0, 16)}...`);
  } catch (error) {
    console.log(`   ❌ Sell error: ${(error as Error).message}`);
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
      // Capture blockhash
      if (data?.blockMeta?.blockhash) {
        const hashBytes = data.blockMeta.blockhash;
        cachedBlockhash = typeof hashBytes === 'string' ? hashBytes : bs58.encode(Buffer.from(hashBytes));
      }

      // Detect new pump tokens
      const txn = data?.transaction;
      if (!txn?.transaction?.meta?.postTokenBalances) return;

      const meta = txn.transaction.meta;
      const mintStr = meta.postTokenBalances[0]?.mint;

      if (!mintStr || !mintStr.endsWith("pump")) return;

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
      console.log(`\n🪙 Token #${tokensDetected}: ${mintStr.slice(0, 8)}...`);

      const message = txn.transaction.transaction?.message;
      const accountKeys = message?.accountKeys;
      if (!accountKeys || accountKeys.length === 0) {
        console.log(`   ❌ No account keys`);
        return;
      }

      const creatorBytes = accountKeys[0];
      const creator = typeof creatorBytes === 'string' ? creatorBytes : bs58.encode(Buffer.from(creatorBytes));

      buyAttempts++;
      lastBuyTime = now;

      buyToken(connection, trader, mintStr, creator);
    } catch {}
  });

  const req: any = {
    accounts: {
      bondingCurves: {
        owner: [CONFIG.PUMP_PROGRAM.toBase58()],
        account: [],
        filters: [
          {
            memcmp: {
              offset: "0",
              bytes: new Uint8Array(Buffer.from([0x01])),
            },
          },
        ],
      },
    },
    slots: {},
    transactions: {
      pumpfun: {
        vote: false,
        failed: false,
        signature: undefined,
        accountInclude: [],
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
    accountsDataSlice: [
      {
        offset: "0",
        length: "100",
      },
    ],
    commitment: CommitmentLevel.PROCESSED,
  };

  stream.write(req);
  await new Promise(() => {});
}

main().catch(console.error);
