# Setup Guide

Complete setup instructions for Fresh Sniper.

## Prerequisites

- Node.js >= 20.0.0
- pnpm >= 9.0.0
- Shyft API account (for Geyser stream)
- Funded Solana wallet (for transactions)

## Step 1: Install Dependencies

```bash
cd freshSniper
pnpm install
```

## Step 2: Configure Environment

Create `.env` file:

```bash
# Geyser Stream (Required)
GRPC_URL=grpc.ny.shyft.to:443
X_TOKEN=your-shyft-api-key

# Solana RPC (Required)
SOLANA_RPC_PRIMARY=https://rpc.shyft.to?api_key=your-key

# Geyser Config (for config system)
GEYSER_ENDPOINT=grpc.ny.shyft.to:443
GEYSER_AUTH_TOKEN=your-shyft-api-key

# Wallet (Required)
TRADER_KEYPAIR_PATH=./keypairs/trader.json
```

## Step 3: Create Wallet

```bash
mkdir -p keypairs
```

Place your Solana wallet keypair JSON at `keypairs/trader.json`:

```json
[123,45,67,...]  // Your 64-byte secret key
```

**⚠️ IMPORTANT**: Use a dedicated wallet for sniping, not your main wallet!

## Step 4: Test Stream Detection

Run in safe mode (no buying):

```bash
pnpm dev:working
```

/*
You should see:
✅ Stream connected
🪙 TOKEN #1 DETECTED
   Mint: CdqR1y3i8bVr9YY42yDaMQyadM4V4bkZVwbqvnHWpump
*/

If you see tokens being detected, the stream is working!

## Step 5: Configure Strategy

Edit `config/default.toml`:

```toml
[strategy]
buy_amount_sol = 0.001      # Start small!
max_slippage_bps = 500      # 5%

[jito]
priority_fee_lamports = 100000
```

## Step 6: Test Full Sniper

**⚠️ This will spend real SOL!**

```bash
pnpm dev:full
```

Watch for:

✅ Sim OK: 67ms
✅ Sent via Jito: 5VERv8NMvz...
🎉 CONFIRMED: ...

## Troubleshooting

### "Cannot find module 'zod'"

```bash
pnpm install -w zod
```

### "ENOENT: no such file or directory, open './keypairs/trader.json'"

Create the keypairs directory and add your wallet JSON.

### Stream connects but no tokens detected

- Verify `GRPC_URL` and `X_TOKEN` are correct
- Check Shyft API quota hasn't been exceeded
- Pump.fun may have slow periods

### Simulation fails

- Check wallet has enough SOL
- Verify slippage settings
- Token may have low liquidity

## Jito Tip Accounts

Rotate between these accounts for better distribution:

96gYZGLnJYVFmbjzopPSU6QiEV5fGqZNyN9nmNhvrZU5
HFqU5x63VTqvQss8hp11i4wVV8bD44PvwucfZ2bU7gRe
Cw8CFyM9FkoMi7K7Crf6HNQqf4uEMzpKw6QNghXLvLkY
ADaUMid9yfUytqMBgopwjb2DTLSokTSzL1zt6iGPaS49
DfXygSm4jCyNCybVYYK6DwvWqjKee8pbDmJGcLWNDXjh
ADuUkR4vqLUMWXxW9gh6D6L8pMSawimctcNZ5pGwDcEt
DttWaMuVvTiduZRnguLF7jNxTgiMBZ1hyAumKUiL2KRL
3AVi9Tg9Uo68tJfuvoKvqKNWKkC5wPdSSdeBnizKZ6jT

Update `config/default.toml` with one of these.

## Performance Tuning

### For Speed

- Set `priority_fee_lamports = 200000` (higher fee)
- Use dedicated RPC endpoint (not public)
- Reduce `buy_amount_sol` for faster execution

### For Cost Efficiency

- Set `priority_fee_lamports = 50000` (lower fee)
- May have slower transaction landing

## Next Steps

Once basic operation is verified:

1. Add filters (liquidity, creator whitelist)
2. Implement automated selling
3. Add position tracking
4. Scale with multiple strategies
