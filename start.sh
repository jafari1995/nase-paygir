#!/bin/bash
# (re)start the bot in background; secrets must be in env (TELEGRAM_BOT_TOKEN, OPENROUTER_API_KEY)
cd /workspace/followup-bot
pkill -f "followup-bot/run.sh" ; pkill -f "python3 -u /workspace/followup-bot/bot.py"; sleep 1
setsid nohup /workspace/followup-bot/run.sh > /dev/null 2>&1 < /dev/null &
echo started
