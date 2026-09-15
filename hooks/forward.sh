#!/bin/bash
# Forwards a Claude Code hook event to the haiflow server.
# Only fires when session was started by haiflow (HAIFLOW=1 is set via tmux -e).
# Usage: forward.sh <endpoint>  (e.g. forward.sh /hooks/stop)
#
# HAIFLOW_SESSION (also set via tmux -e) names the haiflow session this Claude
# belongs to. It travels as a header so the server resolves the hook by name,
# not by guessing which unlinked session a new Claude id belongs to -- the guess
# crossed hooks between sessions started in the same second.
[ "$HAIFLOW" != "1" ] && exit 0
session_header=()
[ -n "${HAIFLOW_SESSION:-}" ] && session_header=(-H "X-Haiflow-Session: ${HAIFLOW_SESSION}")
curl -s -X POST "http://localhost:${HAIFLOW_PORT:-3333}$1" \
  -H "Content-Type: application/json" \
  "${session_header[@]}" \
  --data-binary @- > /dev/null 2>&1 || true
