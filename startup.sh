#!/bin/sh
set -eu
cd /workspace
node scripts/preview.mjs stop || true
if [ -x /usr/local/bin/umbrad ]; then
  if ! curl -sf -o /dev/null --max-time 1 http://127.0.0.1:4401/health; then
    mkdir -p /tmp/umbra-tls
    /usr/local/bin/umbrad -listen 127.0.0.1:4400 -api 127.0.0.1:4401 -bind 127.0.0.1 -tls-dir /tmp/umbra-tls >>/tmp/umbrad.log 2>&1 &
  fi
fi
if curl -sf -o /dev/null --max-time 2 http://127.0.0.1:8080/; then
  exit 0
fi
npm run dev >>/tmp/app-startup.log 2>&1 &
