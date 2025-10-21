import "dotenv/config";
import { Connection, PublicKey } from "@solana/web3.js";
import { 
  deriveBondingCurvePDA,
  deriveCreatorVaultPDA,
  deriveGlobalVolumeAccumulatorPDA,
  deriveUserVolumeAccumulatorPDA,
  deriveFeeConfigPDA
} from "../packages/transactions/src/pumpfun/pdas";
import { fetchBondingCurveState } from "../packages/transactions/src/pumpfun/curve-parser";
import { readFileSync } from "fs";

const mint = new PublicKey("GmwyfnZt8VFuhQMtAGCeJD8CFg5NvgcQJWUZdxECpump");
const connection = new Connection(process.env.SOLANA_RPC_PRIMARY!);

const keypairData = JSON.parse(readFileSync("./keypairs/trader.json", "utf-8"));
const trader = PublicKey.unique(); // Just for testing PDA derivation

async function test() {
  console.log("🔍 Debugging Sell Accounts");
  console.log("Mint:", mint.toBase58(), "\n");
  
  const [bondingCurve] = deriveBondingCurvePDA(mint);
  console.log("0-3: bondingCurve:", bondingCurve.toBase58());
  
  const curveState = await fetchBondingCurveState(connection, bondingCurve);
  console.log("    creator from curve:", curveState.creator.toBase58());
  
  const [creatorVault] = deriveCreatorVaultPDA(curveState.creator);
  console.log("9: creatorVault:", creatorVault.toBase58());
  
  const [globalVol] = deriveGlobalVolumeAccumulatorPDA();
  console.log("12: globalVol:", globalVol.toBase58());
  
  const [userVol] = deriveUserVolumeAccumulatorPDA(trader);
  console.log("13: userVol:", userVol.toBase58());
  
  const [feeConfig] = deriveFeeConfigPDA();
  console.log("14: feeConfig:", feeConfig.toBase58());
}

test().catch(console.error);

