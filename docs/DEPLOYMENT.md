# Deployment Guide

## Pre-Deployment Checklist

- [ ] Tested with stream-only mode (`pnpm dev:working`)
- [ ] Verified transaction building and simulation
- [ ] Tested with small amounts (0.001 SOL)
- [ ] Reviewed and validated all configuration
- [ ] Wallet has sufficient SOL for fees (minimum 0.1 SOL recommended)
- [ ] Monitoring and alerting set up
- [ ] Backup RPC endpoints configured

## Production Configuration

### config/production.toml

Create environment-specific config:

```toml
[environment]
name = "production"

[strategy]
buy_amount_sol = 0.01      # Adjust based on strategy
max_slippage_bps = 300     # 3% for production

[jito]
priority_fee_lamports = 150000  # Higher for better landing
```

### Environment Variables

```bash
FRESH_SNIPER_ENV=production
SOLANA_RPC_PRIMARY=your-premium-rpc-endpoint
GEYSER_ENDPOINT=grpc.ny.shyft.to:443
GEYSER_AUTH_TOKEN=production-token
TRADER_KEYPAIR_PATH=/secure/path/to/keypair.json
```

## Running in Production

### Using PM2

```bash
# Install PM2
npm install -g pm2

# Start sniper
pm2 start "pnpm dev:full" --name fresh-sniper

# Monitor
pm2 logs fresh-sniper

# Stop
pm2 stop fresh-sniper
```

### Using systemd

Create `/etc/systemd/system/fresh-sniper.service`:

```ini
[Unit]
Description=Fresh Sniper
After=network.target

[Service]
Type=simple
User=sniper
WorkingDirectory=/home/sniper/freshSniper
Environment="PATH=/home/sniper/.nvm/versions/node/v20.0.0/bin:/usr/bin"
ExecStart=/usr/bin/pnpm dev:full
Restart=always
RestartSec=10

[Install]
WantedBy=multi-user.target
```

Enable and start:

```bash
sudo systemctl enable fresh-sniper
sudo systemctl start fresh-sniper
sudo journalctl -u fresh-sniper -f
```

## Monitoring

### Metrics

Check `logs/mvp-metrics.log`:

```bash
tail -f logs/mvp-metrics.log | jq '.summary'
```

### Key Metrics to Watch

- `tokensDetected` - Should be >0 if Pump.fun is active
- `simSuccess / simFailed` - Success rate should be >80%
- `txConfirmed / txFailed` - Transaction success rate
- Detection latency - Should be <10ms

### Alerts

Set up alerts for:

- Zero tokens detected for >60 seconds (stream issue)
- Simulation success rate <50% (RPC issues or insufficient SOL)
- Transaction failure rate >20% (need to increase priority fee)

## Security

- **Never commit** keypairs or .env files
- **Use dedicated wallet** for sniping only
- **Rotate API keys** regularly
- **Monitor wallet balance** - set up low-balance alerts
- **Secure keypair storage** - consider hardware wallet or HSM for large amounts

## Scaling

### Multiple Instances

Run separate instances for different strategies:

```bash
# Instance 1: Small buys, high frequency
FRESH_SNIPER_ENV=production-small pnpm dev:full

# Instance 2: Larger buys, filtered
FRESH_SNIPER_ENV=production-large pnpm dev:full
```

### Load Balancing

- Use multiple RPC endpoints in `rpc.fallback_urls`
- Rotate Jito tip accounts
- Distribute across multiple servers if needed

## Troubleshooting

### High Failure Rate

1. Increase `priority_fee_lamports`
2. Check RPC endpoint latency
3. Verify Jito tip amount is sufficient (minimum 1000 lamports)

### Stream Disconnections

- Check Shyft API quota
- Verify network connectivity
- Review reconnection backoff settings

### Out of SOL

- Set up balance monitoring
- Configure low-balance alerts
- Implement auto-pause when balance low

## Backup and Recovery

### Backup Configuration

```bash
tar -czf backup-$(date +%Y%m%d).tar.gz config/ .env keypairs/
```

### Trade History

Metrics logs contain all trade data:

```bash
cp -r logs/ logs-backup-$(date +%Y%m%d)/
```

## Maintenance

### Regular Tasks

- Daily: Check success rates and adjust fees
- Weekly: Review trade performance and PnL
- Monthly: Rotate API keys and update dependencies

### Updates

```bash
# Update dependencies
pnpm update

# Rebuild
pnpm clean
pnpm build

# Test before deploying
pnpm dev:working
```
