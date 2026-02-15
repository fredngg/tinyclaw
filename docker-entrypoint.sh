#!/bin/bash
# =============================================================================
# TinyClaw Docker Entrypoint — Secure Startup
# =============================================================================
# Validates environment, ensures directories, starts the daemon.
# Runs as non-root user (tinyclaw, UID 1000).
# =============================================================================
set -euo pipefail

echo "╔════════════════════════════════════════╗"
echo "║   TinyClaw — Secure Container Start   ║"
echo "╚════════════════════════════════════════╝"
echo ""

# --- Validate required environment variables ---
REQUIRED_VARS=("OPENROUTER_API_KEY")
OPTIONAL_VARS=("DISCORD_BOT_TOKEN" "TELEGRAM_BOT_TOKEN")

MISSING=()
for var in "${REQUIRED_VARS[@]}"; do
    if [ -z "${!var:-}" ]; then
        MISSING+=("$var")
    fi
done

if [ ${#MISSING[@]} -ne 0 ]; then
    echo "ERROR: Missing required environment variables:"
    for var in "${MISSING[@]}"; do
        echo "  - $var"
    done
    echo ""
    echo "Set them in your .env file or pass via docker compose."
    exit 1
fi

# Check at least one channel token is set
HAS_CHANNEL=false
for var in "${OPTIONAL_VARS[@]}"; do
    if [ -n "${!var:-}" ]; then
        HAS_CHANNEL=true
        break
    fi
done

if [ "$HAS_CHANNEL" = false ]; then
    echo "WARNING: No channel bot tokens set (DISCORD_BOT_TOKEN, TELEGRAM_BOT_TOKEN)."
    echo "         TinyClaw will start but won't connect to any channels."
    echo ""
fi

# --- Ensure data directories exist ---
TINYCLAW_HOME="${TINYCLAW_HOME:-/data/tinyclaw}"
mkdir -p "$TINYCLAW_HOME/queue/incoming" \
         "$TINYCLAW_HOME/queue/outgoing" \
         "$TINYCLAW_HOME/queue/processing" \
         "$TINYCLAW_HOME/logs" \
         "$TINYCLAW_HOME/events" \
         "$TINYCLAW_HOME/chats" \
         "$TINYCLAW_HOME/files"

# --- Create settings.json if it doesn't exist ---
if [ ! -f "$TINYCLAW_HOME/settings.json" ]; then
    echo "Creating default settings.json..."
    cat > "$TINYCLAW_HOME/settings.json" << 'SETTINGS_EOF'
{
    "channels": {},
    "models": {
        "provider": "openrouter"
    },
    "agents": {
        "default": {
            "name": "Assistant",
            "provider": "openrouter",
            "model": "sonnet",
            "working_directory": "/data/tinyclaw/workspace"
        }
    }
}
SETTINGS_EOF
fi

# --- Security: verify we are NOT root ---
if [ "$(id -u)" = "0" ]; then
    echo "ERROR: Container is running as root! This violates security policy."
    echo "       Use 'user: 1000:1000' in docker-compose.yml"
    exit 1
fi

echo "Security checks passed:"
echo "  User: $(whoami) (UID=$(id -u))"
echo "  Read-only rootfs: $(mount | grep ' / ' | grep -q 'ro' && echo 'yes' || echo 'no (warning)')"
echo "  Capabilities: $(cat /proc/1/status 2>/dev/null | grep CapEff | awk '{print $2}' || echo 'unknown')"
echo ""

# --- Start TinyClaw ---
echo "Starting TinyClaw daemon..."
exec bash ./tinyclaw.sh start
