#!/bin/zsh
cd "$(dirname "$0")"
set -a
source .env
set +a
exec /opt/homebrew/bin/node server.js
