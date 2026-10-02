#!/bin/bash
# Preview self-heal watchdog (Task 24): restarts dev server if :3000 stops responding.
# Tiny shell loop (~2MB RSS) — survives OOM kills that target the large next-server process.
# Touches NO app code / DB / Flaship / env — only restarts with the EXISTING configuration.
LOG=/home/z/my-project/dev_watchdog.log
while true; do
  code=$(curl -s -o /dev/null -w "%{http_code}" -m 4 http://localhost:3000/login 2>/dev/null)
  if [ "$code" != "200" ]; then
    echo "$(date -u +%FT%TZ) down (code=$code) -> restarting dev server" >> "$LOG"
    pkill -f "next dev" 2>/dev/null   # prevent stacked instances (OOM safety)
    sleep 1
    cd /home/z/my-project || exit 1
    nohup bun dev >> dev.log 2>&1 &
    echo "$(date -u +%FT%TZ) restart issued (pid $!)" >> "$LOG"
  fi
  sleep 15
done
