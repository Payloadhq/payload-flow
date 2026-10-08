#!/bin/bash
set -e
apt-get update -qq
apt-get install -y -qq curl python3 make g++
curl -sL https://raw.githubusercontent.com/Payloadhq/payload-flow/main/deploy/rail-app.tgz | tar -xz -C /
cd /app
npm rebuild better-sqlite3 2>&1 | tail -2
exec node dist/index.js
