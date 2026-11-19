#!/bin/bash
# restart loop for the follow-up bot
cd /workspace/followup-bot
umask 077
# load secrets from .env if present (otherwise they must already be in the environment)
[ -f .env ] && { set -a; . ./.env; set +a; }
echo $$ > runner.pid
while true; do
  echo "[$(date)] starting bot" >> bot.log
  python3 -u /workspace/followup-bot/bot.py >> bot.log 2>&1
  echo "[$(date)] bot exited ($?), restarting in 5s" >> bot.log
  sleep 5
done
