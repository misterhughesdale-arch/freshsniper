#!/bin/bash
# Stop all sniper processes

echo "🛑 Stopping Fresh Sniper..."
echo ""

pkill -f "full-sniper.ts" && echo "✅ Buy loop stopped" || echo "⚠️  Buy loop not running"
pkill -f "sell-manager" && echo "✅ Sell manager stopped" || echo "⚠️  Sell manager not running"

echo ""
echo "✅ All services stopped"

