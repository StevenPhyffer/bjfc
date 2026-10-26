#!/bin/bash
# Double-click to start the BJFC Command Centre (macOS)
cd "$(dirname "$0")"
[ -d node_modules ] || npm install
(sleep 2 && open "http://localhost:4310") &
node server.js
