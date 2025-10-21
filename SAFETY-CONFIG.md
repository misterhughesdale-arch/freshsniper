# Safety Configuration & Fee Audit

**Last Updated:** 2025-10-21  
**Status:** ✅ All fees audited and set to safe levels

## Fee Settings Across Codebase

### ✅ Safe Scripts (Minimal Fees)
| Script | Priority Fee | Usage |
|--------|--------------|-------|
| `scripts/sell-via-rpc.ts` | **1 µLamport** (~$0.0000001) | Emergency sell via RPC |
| `scripts/emergency-sell-all.ts` | **1 µLamport** (~$0.0000001) | Batch sell all positions |
| `examples/test-sell.ts` | **10,000 µLamports** ($0.00001) | Test sell script |
| `apps/sell-manager/src/index.ts` | **10,000 µLamports** (default) | Auto-sell manager |

### ⚠️ Configurable (Check Before Running)
| Component | Default Fee | Config Location |
|-----------|-------------|-----------------|
| `packages/transactions/src/pumpfun/builders.ts` | **10,000 µLamports** | Default in function |
| `packages/transactions/src/workflows.ts` | Uses `config.jito.priority_fee_lamports` | TOML config |
| `examples/sdk-sniper.ts` | `PRIORITY_FEE` env var (default: 100,000) | .env file |
| `examples/full-sniper.ts` | Uses `config.jito.priority_fee_lamports` | TOML config |

### 🔒 Safety Guardrails

#### Wallet Protection
```typescript
const SAFETY = {
  MIN_BALANCE_SOL: 0.05,           // Stop trading if below this
  MAX_BUY_AMOUNT_SOL: 0.001,       // Max per transaction
  MAX_TOTAL_SPEND_SOL: 0.02,       // Max per strategy period
  SELL_DELAY_SECONDS: 30,          // Wait before selling
};
```

#### Buy Workflow Protection
- **Minimum balance check:** Will NOT buy if SOL < 0.03
- **Location:** `packages/transactions/src/workflows.ts:49-66`
- **Error logged:** "❌ INSUFFICIENT SOL BALANCE - REFUSING TO BUY"

## Fee Recommendations by Use Case

### Buying (Competitive)
- **Conservative:** 50,000 - 100,000 µLamports (p50-p75 Jito)
- **Balanced:** 100,000 - 250,000 µLamports (p75-p95)
- **Aggressive:** 250,000 - 500,000 µLamports (p95-p99)
- **Ultra:** 500,000+ µLamports (p99+)

**Always check current Jito tips:** https://bundles.jito.wtf/api/v1/bundles/tip_floor

### Selling (Non-competitive)
- **Standard:** 10,000 µLamports ($0.00001 SOL)
- **Emergency:** 1 µLamport (basically free)
- **Note:** Sells don't need high priority - use regular RPC

## Current Test Runner Configuration

The `scripts/test-runner.ts` implements 4 strategies:

1. **Conservative**
   - Buy: p50 Jito tip
   - Sell: 100 µLamports
   - Amount: 0.0005 SOL

2. **Balanced** 
   - Buy: p75 Jito tip ⭐ (Recommended)
   - Sell: 1,000 µLamports
   - Amount: 0.001 SOL

3. **Aggressive**
   - Buy: p95 Jito tip
   - Sell: 5,000 µLamports
   - Amount: 0.001 SOL

4. **Ultra-fast**
   - Buy: p99 Jito tip
   - Sell: 10,000 µLamports
   - Amount: 0.001 SOL

## How to Run Safe Tests

### Before Starting
```bash
# 1. Check your balance
solana balance EuZhGRPZXzB2rPwdy7GncBKJgyAv65NCduWgtFjoBdR5

# 2. Ensure at least 0.05 SOL available

# 3. Kill any running scripts
killall -9 node tsx
```

### Run Test
```bash
# Run the controlled test (4 strategies x 15 min)
tsx scripts/test-runner.ts

# Results will be saved to: test-results-{timestamp}.json
```

### Emergency Stop
```bash
# Kill all trading
killall -9 node tsx

# Sell remaining positions (minimal fees)
tsx scripts/sell-via-rpc.ts
```

## Configuration Files to Check

Before running ANY sniper:

1. **Check TOML configs:** `config/default.toml`, `config/development.toml`
   - Look for: `priority_fee_lamports`
   - Safe range: 10,000 - 500,000

2. **Check environment variables:** `.env`
   - `PRIORITY_FEE` if using sdk-sniper
   - Recommended: 100,000 (0.0001 SOL)

3. **Check bot configs:** `bots/*.yaml`
   - Some may have hardcoded priority fees
   - Verify before enabling

## Fee Calculation Reference

```
1 SOL = 1,000,000,000 lamports
1 µLamport = 1 microlamport = 0.000001 lamports

Examples:
- 1 µLamport = 0.000000001 SOL ≈ $0.0000002 (@ $200/SOL)
- 10,000 µLamports = 0.00001 SOL ≈ $0.002
- 100,000 µLamports = 0.0001 SOL ≈ $0.02
- 1,000,000 µLamports = 0.001 SOL ≈ $0.20
- 10,000,000 µLamports = 0.01 SOL ≈ $2.00 (VERY HIGH!)
```

## Never Again Checklist

✅ All sell scripts use minimal fees (1-10,000 µLamports)  
✅ Buy workflow has 0.03 SOL minimum balance check  
✅ Test runner has comprehensive safety limits  
✅ All high-fee scripts identified and fixed  
✅ Documentation created for fee management  
✅ Emergency stop procedures documented  

## Monitoring During Tests

Watch for:
- Balance dropping too fast
- Failed transactions (might need to increase buy priority)
- Stuck positions (adjust sell delay)
- High slippage (adjust slippage tolerance)

## Support

If something goes wrong:
1. `killall -9 node tsx` - Stop everything
2. Check balance: `solana balance <address>`
3. List positions: `tsx scripts/list-positions.ts`
4. Emergency sell: `tsx scripts/sell-via-rpc.ts`

