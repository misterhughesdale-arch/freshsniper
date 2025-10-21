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
import { searcherClient } from "jito-ts/dist/sdk/block-engine/searcher";
import { Bundle } from "jito-ts/dist/sdk/block-engine/types";

// Test configuration
const TEST_DURATION_MS = 15 * 60 * 1000; // 15 minutes
const BUY_AMOUNT = 0.015; // 0.015 SOL per buy
const SELL_DELAY_MS = 3000; // 3 seconds
const BUY_COOLDOWN_MS = 20000; // 20 seconds between buys
const MIN_BALANCE_SOL = 0.05; // Stop if balance drops below this
const JITO_TIP_LAMPORTS = 10000; // 10k lamports tip for Jito
const BUY_PRIORITY_FEE = 33333; // microLamports per CU

const CONFIG = {
  PUMP_PROGRAM: new PublicKey("6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P"),
  PUMP_TOKEN_PROGRAM: new PublicKey("TSLvdd1pWpHVjahSpsvCXUbgwsL3JAcvokwaKt1eokM"),
};

// Jito tip accounts
const JITO_TIP_ACCOUNTS = [
  "96gYZGLnJYVFmbjzopPSU6QiEV5fGqZNyN9nmNhvrZU5",
  "HFqU5x63VTqvQss8hp11i4wVV8bD44PvwucfZ2bU7gRe",
  "Cw8CFyM9FkoMi7K7Crf6HNQqf4uEMzpKw6QNghXLvLkY",
  "ADaUMid9yfUytqMBgopwjb2DTLSokTSzL1zt6iGPaS49",
  "DfXygSm4jCyNCybVYYK6DwvWqjKee8pbDmJGcLWNDXjh",
  "ADuUkR4vqLUMWXxW9gh6D6L8pMSawimctcNZ5pGwDcEt",
  "DttWaMuVvTiduZRnguLF7jNxTgiMBZ1hyAumKUiL2KRL",
  "3AVi9Tg9Uo68tJfuvoKvqKNWKkC5wPdSSdeBnizKZ6jT",
].map((a) => new PublicKey(a));

function getRandomJitoTipAccount(): PublicKey {
  return JITO_TIP_ACCOUNTS[Math.floor(Math.random() * JITO_TIP_ACCOUNTS.length)];
}

// State tracking
let cachedBlockhash: string | null = null;
const processedMints = new Set<string>();
let lastBuyTime = 0;
let tokensDetected = 0;
let buyAttempts = 0;
let startTime = Date.now();

async function sendBundleViaJito(
  bundleTransactions: Buffer[],
  jitoClient: ReturnType<typeof searcherClient>,
): Promise<string> {
  try {
    const bundle = new Bundle(bundleTransactions, bundleTransactions.length);
    const bundleId = await jitoClient.sendBundle(bundle);
    return bundleId;
  } catch (error) {
    throw new Error(`Jito bundle send failed: ${(error as Error).message}`);
  }
}

async function buyToken(
  connection: Connection,
  trader: Keypair,
  jitoClient: ReturnType<typeof searcherClient>,
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

    // Add Jito tip
    const tipAccount = getRandomJitoTipAccount();
    transaction.add(
      SystemProgram.transfer({
        fromPubkey: trader.publicKey,
        toPubkey: tipAccount,
        lamports: JITO_TIP_LAMPORTS,
      }),
    );

    transaction.sign(trader);

    // Send via Jito
    const bundleId = await sendBundleViaJito([transaction.serialize()], jitoClient);
    console.log(`   ✅ BUY (Jito): ${bundleId.slice(0, 16)}...`);

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

  // Initialize Jito client
  const jitoClient = searcherClient(
    process.env.BLOCK_ENGINE_URL || "https://mainnet.block-engine.jito.wtf",
    trader,
  );

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

      buyToken(connection, trader, jitoClient, mintStr, creator);
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
