#!/bin/bash
# Task 19: restore dev server + diagnose why background processes die between calls
# READ-ONLY diagnostics; restart uses EXISTING config; no code/DB/catalog/booking changes

echo "=== [1] memory / cgroup limits ==="
cat /sys/fs/cgroup/memory.max 2>/dev/null || cat /sys/fs/cgroup/memory/memory.limit_in_bytes 2>/dev/null
cat /sys/fs/cgroup/memory.current 2>/dev/null || cat /sys/fs/cgroup/memory/memory.usage_in_bytes 2>/dev/null
free -m 2>/dev/null | head -3

echo "=== [2] OOM kill evidence (dmesg) ==="
dmesg 2>/dev/null | grep -iE "oom|killed process" | tail -5 || echo "(dmesg unavailable)"

echo "=== [3] stale processes on :3000 ==="
ps aux | grep "[n]ext dev" | awk '{print $2, $11, $12, $13}' || true

echo "=== [4] start dev server (plain background child of persistent shell, NO setsid) ==="
cd /home/z/my-project || exit 1
bunx next dev -p 3000 >> dev.log 2>&1 &
SERVER_PID=$!
echo "started pid=$SERVER_PID"

echo "=== [5] continuous probe for 60s (survival window test) ==="
for i in $(seq 1 12); do
  sleep 5
  code=$(curl -s -o /dev/null -w "%{http_code}" -m 4 http://localhost:3000/login)
  alive=$(ps -p $SERVER_PID > /dev/null 2>&1 && echo yes || echo no)
  echo "t+$((i*5))s pid_alive=$alive GET /login -> $code"
  [ "$code" = "200" ] && [ "$alive" = "yes" ] && break
done

echo "=== [6] final state ==="
ps aux | grep "[n]ext dev" | awk '{print $2, $11, $12, $13}' || echo "(no next dev process)"
tail -3 dev.log
