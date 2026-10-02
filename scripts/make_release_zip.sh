#!/bin/bash
# Task 29: royalcarepk-vercel-github.zip — clean release archive for GitHub upload
# EXCLUDES: .env*, .git, .next, node_modules, logs, caches, workspace/platform dirs
set -euo pipefail
ROOT=/home/z/my-project
OUT=/home/z/my-project/download/royalcarepk-vercel-github.zip
STAMP=$(date -u +%FT%TZ)

cd "$ROOT"

# --- STEP 1: pre-flight secret-file check on include list ---
echo "[$STAMP] pre-flight: scanning include list for forbidden filenames..."
FORBIDDEN=$(printf '%s\n' \
  src public supabase scripts prisma tests \
  package.json bun.lock next.config.ts tsconfig.json next-env.d.ts \
  eslint.config.mjs postcss.config.mjs tailwind.config.ts components.json \
  .gitignore README.md .env.local.example \
  -type f -o -type d 2>/dev/null | true)
BAD=$(find src public supabase scripts prisma tests \
  \( -name ".env" -o -name ".env.*" -o -name "*.pem" -o -name "*.key" \
     -o -name "custom.db" -o -name "*.sqlite*" \
     -o -name "*.log" \) 2>/dev/null || true)
if [ -n "$BAD" ]; then
  echo "FORBIDDEN FILES FOUND IN INCLUDE LIST:"; echo "$BAD"; exit 1
fi
echo "pre-flight clean (no .env/key/db/log files under included dirs)"

# --- STEP 2: create zip with explicit allowlist (relative paths, structure preserved) ---
mkdir -p /home/z/my-project/download
rm -f "$OUT"
zip -r -q "$OUT" \
  src public supabase scripts prisma tests \
  package.json bun.lock next.config.ts tsconfig.json next-env.d.ts \
  eslint.config.mjs postcss.config.mjs tailwind.config.ts components.json \
  .gitignore README.md .env.local.example \
  -x "*.log" "*.db" "*.sqlite*" ".env*" "*.tsbuildinfo" \
     "*node_modules*" "*.pem" "*.key"

# --- STEP 3: verify archive contents (filenames) ---
echo "=== verification: forbidden names inside zip ==="
if unzip -l "$OUT" | grep -E "\.env($|\.)|\.git/|node_modules|\.next/|\.log$|\.db$|\.sqlite|tsbuildinfo|Caddyfile|worklog\.md|\.zscripts" ; then
  echo "FAIL: forbidden file found in zip"; exit 1
else
  echo "PASS: no .env/.git/node_modules/.next/logs/db/Caddyfile/worklog in zip"
fi

# --- STEP 4: content secret scan on extracted copy ---
TMP=$(mktemp -d)
unzip -q "$OUT" -d "$TMP"
echo "=== verification: secret-pattern content scan ==="
HITS=$(grep -rIlE "eyJ[A-Za-z0-9_-]{30,}|sk-[A-Za-z0-9]{20,}|sbp_[A-Za-z0-9]{20,}|BEGIN [A-Z ]*PRIVATE KEY|v1\.[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{20,}|(api_?key|password|secret|token)\s*[:=]\s*['\"][A-Za-z0-9+/]{16,}" \
  "$TMP" --exclude-dir=.git 2>/dev/null || true)
if [ -n "$HITS" ]; then
  echo "POTENTIAL SECRET PATTERNS FOUND:"; echo "$HITS"; rm -rf "$TMP"; exit 1
else
  echo "PASS: no secret-like content in any included file"
fi
rm -rf "$TMP"

# --- STEP 5: summary ---
FILES=$(unzip -l "$OUT" | tail -1 | awk '{print $2}')
SIZE=$(du -h "$OUT" | cut -f1)
echo "=== DONE ==="
echo "zip: $OUT"
echo "files: $FILES | size: $SIZE"
