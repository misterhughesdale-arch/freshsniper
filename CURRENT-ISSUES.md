# Current Issues - Fresh Sniper

**Last Updated**: October 21, 2025

---

## 🚨 Critical Issues

### 1. Service Import Errors
**Status**: BLOCKING  
**Affected**: sell-manager, pnl-monitor  
**Error**:
```
SyntaxError: The requested module '@fresh-sniper/transactions' does not provide an export named 'buildSellTransaction'
```

**Root Cause**: TypeScript module resolution issue with workspace packages when using `tsx`

**Workaround**: Use direct imports in examples (not apps)
```typescript
// Works in examples/
import { buildSellTransaction } from "../packages/transactions/src/pumpfun/builders";

// Fails in apps/
import { buildSellTransaction } from "@fresh-sniper/transactions";
```

**Fix Options**:
1. Move services back to examples/ (quick fix)
2. Fix package.json exports properly
3. Use tsconfig paths resolution

**Impact**: Sell manager and PnL monitor won't start

---

## ⚠️ Known Issues

### 2. Buy Transactions Not Tested Since Speed Optimization
**Status**: NEEDS TESTING  
**Description**: Removed `fetchBondingCurveState()` RPC call for speed
- Changed from: Fetch creator from blockchain (300-500ms)
- Changed to: Extract creator from transaction (instant)

**Risk**: Creator might not always be accountKeys[0]

**Testing Needed**: Run `pnpm dev:full` and verify buys still work

---

## 📋 Minor Issues

### 3. Sell Manager Using Wrong Config Path
**Status**: DOCUMENTED  
**Workaround**: Uses `process.env.TRADER_KEYPAIR_PATH` instead of `config.trader.keypair_path`

### 4. Circuit Breaker Not Integrated
**Status**: CREATED BUT NOT TESTED  
**Next Step**: Test if buy loop actually checks circuit breaker file

---

## ✅ Recently Fixed

- ✅ Sell account order (creator_vault before token_program)
- ✅ Sell has 16 accounts (not 14)
- ✅ track_volume byte added (25 bytes total)
- ✅ Bulk recovery script working
- ✅ Dust recovery confirmed working (0.012 SOL recovered)

---

## 🎯 Immediate Actions Needed

1. **Fix service imports** - Move to examples or fix package resolution
2. **Test buy loop** - Verify creator extraction works
3. **Test circuit breaker** - Confirm buy loop checks pause state
4. **Integration test** - Run all 3 services together

---

## 📊 Working Components

- ✅ Stream detection (1500+ tokens)
- ✅ Buy transactions (120+ confirmed at commit 1ccb5fe)
- ✅ Sell transactions (multiple confirmed)
- ✅ Bulk recovery (confirmed working)
- ✅ Configuration system
- ✅ Documentation

---

**Priority**: Fix import issues, test end-to-end

