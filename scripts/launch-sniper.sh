#!/bin/bash
# Fresh Sniper Launcher
# Starts both buy and sell processes concurrently

set -e

echo "🚀 FRESH SNIPER LAUNCHER"
echo "========================"
echo ""
echo "Starting services:"
echo "  1. Buy Loop (full-sniper)"
echo "  2. Sell Manager (auto-sell)"
echo "  3. PnL Monitor (profitability tracking + circuit breaker)"
echo ""

# Create logs directory
mkdir -p logs

# Kill any existing processes
pkill -f "full-sniper.ts" || true
pkill -f "sell-manager" || true
pkill -f "pnl-monitor" || true
sleep 1

echo "✅ Starting buy loop..."
cd /home/memez/snipers/freshSniper
TMPDIR=~/tmp pnpm dev:full > logs/buy-loop.log 2>&1 &
BUY_PID=$!
echo "   PID: $BUY_PID"
echo "   Log: logs/buy-loop.log"
sleep 2

echo "✅ Starting sell manager..."
pnpm sell:manager > logs/sell-manager.log 2>&1 &
SELL_PID=$!
echo "   PID: $SELL_PID"
echo "   Log: logs/sell-manager.log"
sleep 2

echo "✅ Starting PnL monitor..."
pnpm pnl:monitor > logs/pnl-monitor.log 2>&1 &
PNL_PID=$!
echo "   PID: $PNL_PID"
echo "   Log: logs/pnl-monitor.log"
sleep 2

echo ""
echo "📊 STATUS"
echo "========="
ps -p $BUY_PID > /dev/null 2>&1 && echo "✅ Buy loop running (PID $BUY_PID)" || echo "❌ Buy loop failed"
ps -p $SELL_PID > /dev/null 2>&1 && echo "✅ Sell manager running (PID $SELL_PID)" || echo "❌ Sell manager failed"
ps -p $PNL_PID > /dev/null 2>&1 && echo "✅ PnL monitor running (PID $PNL_PID)" || echo "❌ PnL monitor failed"

echo ""
echo "📝 Monitor with:"
echo "  tail -f logs/buy-loop.log"
echo "  tail -f logs/sell-manager.log"
echo "  tail -f logs/pnl-monitor.log"
echo ""
echo "🛑 Stop with:"
echo "  pnpm stop:sniper"
echo ""
echo "🔒 Circuit Breaker:"
echo "  PnL monitor will auto-pause if losing >5% or 10 consecutive losses"
echo "  Check: logs/circuit-breaker.json"
echo ""
echo "🎯 All services running! Press Ctrl+C to view logs, or use tail -f"

# Trap Ctrl+C to show logs
trap 'echo ""; echo "Showing last 20 lines of each log:"; echo ""; echo "=== BUY LOOP ==="; tail -20 logs/buy-loop.log; echo ""; echo "=== SELL MANAGER ==="; tail -20 logs/sell-manager.log; exit' INT

# Wait for user input
read -p "Press Enter to view live logs (Ctrl+C to exit)..."

# Show live logs side-by-side
echo ""
echo "📊 LIVE LOGS (Ctrl+C to stop)"
echo "=============================="
tail -f logs/buy-loop.log logs/sell-manager.log logs/pnl-monitor.log

