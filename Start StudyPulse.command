#!/bin/bash
cd "$(dirname "$0")"

echo "🔄 Stopping any existing StudyPulse..."
lsof -ti :3000 | xargs kill -9 2>/dev/null
lsof -ti :3001 | xargs kill -9 2>/dev/null
sleep 1

echo "💬 Opening Messages for SMS reminders..."
open -a Messages

echo "🚀 Starting StudyPulse..."
node server.js
