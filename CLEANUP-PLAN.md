# Cleanup Plan

## Documentation Consolidation

### DELETE (merge important info into README first):
- ARCHITECTURE-REVIEW.md
- AUTO-SELL-COMPLETE.md  
- CURRENT-ISSUES.md
- CURRENT-STATE.md
- FINAL-STATUS.md
- GIT-SETUP.md
- KNOWN-ISSUES.md
- PROJECT-SUMMARY.md
- PUSH-INSTRUCTIONS.md
- SESSION-SUMMARY.md
- WHERE-WE-ARE.md

### KEEP:
- README.md (enhanced)
- docs/SETUP.md
- docs/DEVELOPMENT.md
- docs/DEPLOYMENT.md
- docs/architecture.md

## Examples Cleanup

### DELETE:
- sdk-sniper.ts (SDK approach abandoned)
- grpc-slot-based-latency-checker/
- jito-js-rpc/
- making_a_grpc_connection/
- stream_pump_fun_new_minted_tokens/
- stream_pump_fun_transactions_and_detect_buy_sell_events/

### KEEP:
- working-mvp.ts
- full-sniper.ts
- expressSniper.ts
- test-sell.ts

### ARCHIVE SEPARATELY:
- pumpfun-bonkfun-bot/ (Python reference - move to different repo)

## Fix Services

Move from apps/ to examples/:
- apps/sell-manager → examples/sell-manager.ts
- apps/pnl-monitor → examples/pnl-monitor.ts

Remove empty apps/sell-manager and apps/pnl-monitor directories.

## Result

- Documentation: 12 → 5 files
- Examples: 10 → 4 files
- Services: All working from examples/
- Total cleanup: ~15 files/directories removed
