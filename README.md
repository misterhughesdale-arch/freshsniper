# Fresh Sniper

High-performance Solana token sniping bot for Pump.fun. Detects new token creations via Yellowstone Geyser streams and executes buy orders via Jito Block Engine with sub-second latency.

## 🎯 Features

- **Real-time Detection**: 0-1ms latency via Shyft Yellowstone gRPC
- **Jito Integration**: Priority transaction submission with configurable tips
- **Proven Performance**: 100+ tokens/minute detection rate
- **Zero Hardcoding**: All configuration via TOML + environment variables
- **Modular Architecture**: Clean separation of concerns with TypeScript monorepo

## 🚀 Quick Start

```bash
# 1. Install dependencies
pnpm install

# 2. Configure environment
cp .env.template .env
# Edit .env with your credentials

# 3. Add your wallet keypair
mkdir -p keypairs
# Place your keypair JSON at keypairs/trader.json

# 4. Run stream-only mode (SAFE - no buying)
pnpm dev:working

# 5. Run full sniper (⚠️ SPENDS SOL!)
pnpm dev:full
```

## 📋 Requirements

- **Node.js**: >= 20.0.0
- **pnpm**: >= 9.0.0
- **Shyft API key**: For Geyser stream access
- **Funded Solana wallet**: For transaction fees and buys

## ⚙️ Configuration

Edit `config/default.toml`:

```toml
[strategy]
buy_amount_sol = 0.001        # SOL per buy
max_slippage_bps = 500        # 5% slippage

[jito]
priority_fee_lamports = 100000  # Priority fee
tip_account_pubkey = "96gY..."  # Jito tip account
```

Set credentials in `.env`:

```bash
GRPC_URL=grpc.ny.shyft.to:443
X_TOKEN=your-shyft-api-key
SOLANA_RPC_PRIMARY=https://rpc.shyft.to?api_key=...
GEYSER_ENDPOINT=grpc.ny.shyft.to:443
GEYSER_AUTH_TOKEN=your-token
TRADER_KEYPAIR_PATH=./keypairs/trader.json
```

## 📊 What You'll See

## 🚀 WORKING MVP - Pump.fun Token Sniper

======================================

🔗 RPC: <https://rpc.shyft.to>...
📡 Geyser: grpc.ny.shyft.to:443
🎯 Watching: 6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P

✅ Stream connected - watching for Pump.fun tokens...

🪙 TOKEN #1 DETECTED
   Mint: CdqR1y3i8bVr9YY42yDaMQyadM4V4bkZVwbqvnHWpump
   Owner: CJeyCiJDaZ7jGd21p7RBoo4kQDzj5wn7xWrX52UJhZdt
   Detection: 0ms
   ⚙️  Built: 45ms | Tip: 100000 lamports
   ✅ Sim OK: 67ms | Units: 145623
   ✅ Sent via Jito: 5VERv8NMvz... (89ms)
   📊 Total: 201ms

## 📁 Project Structure

freshSniper/
├── packages/           # Shared libraries
│   ├── config/        # TOML config loader with Zod validation
│   ├── logging/       # Structured logging
│   ├── metrics/       # Performance tracking
│   ├── events/        # Domain event bus
│   ├── store/         # Trade position management
│   ├── solana-client/ # RPC/WebSocket/Jito clients
│   └── transactions/  # Pump.fun transaction builders
├── examples/
│   ├── working-mvp.ts   # Stream only (SAFE)
│   └── full-sniper.ts   # With Jito sending (LIVE)
├── config/
│   └── default.toml     # Main configuration
└── docs/              # Additional documentation

## 🎮 Commands

```bash
pnpm dev:working   # Stream detection only (safe)
pnpm dev:full      # Full sniper with Jito sending (⚠️ spends SOL!)
pnpm build         # Build all packages
pnpm clean         # Clean build artifacts

## 🔒 Safety

- **Start with stream-only mode** to verify detection works
- **Use small amounts** (0.001 SOL recommended for testing)
- **Test wallet first** - don't use your main wallet
- **Monitor metrics** - check success rates before scaling

## 📈 Metrics

All metrics tracked in real-time:

- Detection latency (0-1ms typical)
- Transaction build time
- Simulation time
- Jito send time
- Confirmation tracking
- Success/failure rates

Press Ctrl+C to see final stats.

## 📚 Documentation

- [Setup Guide](docs/SETUP.md) - Detailed setup instructions
- [Development Guide](docs/DEVELOPMENT.md) - For contributors
- [Architecture](docs/architecture.md) - System design
- [TODO Roadmap](docs/todo.md) - Development roadmap

## 🤝 Contributing

Contributions welcome! Please ensure:

- TypeScript strict mode compliance
- Comprehensive error handling
- Structured logging for all operations
- Zero hardcoded values (use config)

## ⚠️ Disclaimer

This software is for educational purposes. Use at your own risk. Always test with small amounts first.
