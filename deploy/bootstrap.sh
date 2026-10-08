#!/bin/bash
set -e
apt-get update -qq
apt-get install -y -qq curl
curl -sL https://raw.githubusercontent.com/Payloadhq/payload-flow/main/deploy/rail-app.tgz | tar -xz -C /
cd /app
exec node dist/index.js
