#!/usr/bin/env bash
set -euo pipefail

# ─── Scalp Bot VPS Setup ───
# Run once on a fresh Ubuntu 22.04+ VPS
# VPS: Hetzner 178.104.163.255
# SSH:  ssh root@178.104.163.255
# Usage: bash scripts/setup-vps.sh

REPO_DIR="${REPO_DIR:-/root/tradingview-mcp}"
NODE_MAJOR="${NODE_MAJOR:-20}"

echo "=== Scalp Bot VPS Setup ==="
echo "Repo directory: $REPO_DIR"
echo ""

# 1. Install Node.js
echo ">>> Installing Node.js $NODE_MAJOR..."
curl -fsSL https://deb.nodesource.com/setup_$NODE_MAJOR.x | sudo -E bash -
sudo apt-get install -y nodejs

# 2. Install PM2
echo ">>> Installing PM2..."
sudo npm install -g pm2

# 3. Install PM2 log rotation
echo ">>> Installing pm2-logrotate..."
pm2 install pm2-logrotate

# 4. Install repo dependencies
echo ">>> Installing project dependencies..."
cd "$REPO_DIR"
npm install

# 5. Set up .env (prompt user)
if [ ! -f .env ]; then
  echo ""
  echo ">>> .env file not found. Create it now:"
  echo "    nano $REPO_DIR/.env"
  echo ""
  echo "    Required vars:"
  echo "    ALPACA_API_KEY=..."
  echo "    ALPACA_SECRET_KEY=..."
  echo "    ALPACA_PAPER=true"
  echo "    TELEGRAM_BOT_TOKEN=..."
  echo "    TELEGRAM_CHAT_ID=..."
  echo ""
  read -p "Press Enter after creating .env, or Ctrl+C to abort..."
fi

# 6. Secure .env
chmod 600 .env

# 7. Create logs directory
mkdir -p logs

# 8. Set up systemd service for telegram-ctl
echo ">>> Setting up systemd service..."
sudo cp scripts/scalp-bot-ctl.service /etc/systemd/system/scalp-bot-ctl.service
sudo systemctl daemon-reload
sudo systemctl enable scalp-bot-ctl

# 9. Set timezone to ET
echo ">>> Setting timezone to America/New_York..."
sudo timedatectl set-timezone America/New_York

# 10. Set up cron jobs for session scheduling
echo ">>> Setting up cron jobs for session scheduling..."
(crontab -l 2>/dev/null; cat <<CRON
# Scalp bot session scheduling (ET timezone)
25 9 * * 1-5 cd $REPO_DIR && pm2 start ecosystem.config.cjs >> /var/log/scalp-bot-cron.log 2>&1
5 11 * * 1-5 cd $REPO_DIR && pm2 stop alpaca-bot >> /var/log/scalp-bot-cron.log 2>&1
CRON
) | crontab -

echo ""
echo "=== Setup Complete ==="
echo ""
echo "Next steps:"
echo "  1. Create .env file: nano $REPO_DIR/.env"
echo "  2. Start the controller: sudo systemctl start scalp-bot-ctl"
echo "  3. Check status: sudo systemctl status scalp-bot-ctl"
echo "  4. Test from Telegram: send /start, /status, /stop"
echo "  5. Verify PM2: pm2 list"
echo ""
echo "Useful commands:"
echo "  pm2 list              — Show managed processes"
echo "  pm2 logs alpaca-bot   — View bot logs"
echo "  pm2 describe alpaca-bot — Detailed bot status"
echo "  sudo systemctl status scalp-bot-ctl — Controller status"
echo "  sudo journalctl -u scalp-bot-ctl -f — Controller logs"