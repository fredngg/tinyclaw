# =============================================================================
# TinyClaw Dockerfile — Multi-stage Hardened Build
# =============================================================================
# Security: non-root user, no secrets in layers, minimal attack surface
# No CLI tools (Claude/Codex) needed — uses OpenRouter HTTP API
# =============================================================================

# --- Stage 1: Builder ---
FROM node:22-slim AS builder

WORKDIR /build

# Install only build dependencies
COPY package.json package-lock.json* ./
RUN npm ci --ignore-scripts

# Copy source and build
COPY tsconfig.json ./
COPY src/ ./src/
RUN npm run build

# Prune dev dependencies for runtime
RUN npm prune --omit=dev

# --- Stage 2: Runtime ---
FROM node:22-slim AS runtime

LABEL maintainer="jlia0"
LABEL description="TinyClaw AI Assistant — Hardened Container"

# Install minimal runtime deps only
RUN apt-get update && apt-get install -y --no-install-recommends \
    bash \
    jq \
    tmux \
    chromium \
    dumb-init \
    && rm -rf /var/lib/apt/lists/* \
    && apt-get clean

# Set Puppeteer to use system Chromium (no download)
ENV PUPPETEER_SKIP_CHROMIUM_DOWNLOAD=true
ENV PUPPETEER_EXECUTABLE_PATH=/usr/bin/chromium
ENV CHROME_BIN=/usr/bin/chromium

# Create non-root user (UID/GID 1000 to match --user 1000:1000)
RUN groupadd -g 1000 tinyclaw && \
    useradd -u 1000 -g tinyclaw -m -s /bin/bash tinyclaw

# App directory
WORKDIR /app

# Copy built artifacts from builder (no source, no devDeps)
COPY --from=builder --chown=tinyclaw:tinyclaw /build/node_modules ./node_modules
COPY --from=builder --chown=tinyclaw:tinyclaw /build/dist ./dist
COPY --from=builder --chown=tinyclaw:tinyclaw /build/package.json ./package.json

# Copy runtime scripts
COPY --chown=tinyclaw:tinyclaw tinyclaw.sh ./
COPY --chown=tinyclaw:tinyclaw lib/ ./lib/
COPY --chown=tinyclaw:tinyclaw bin/ ./bin/
COPY --chown=tinyclaw:tinyclaw docker-entrypoint.sh ./

RUN chmod +x tinyclaw.sh docker-entrypoint.sh bin/* lib/*.sh

# Create required directories owned by tinyclaw
RUN mkdir -p /data/tinyclaw/queue/incoming \
             /data/tinyclaw/queue/outgoing \
             /data/tinyclaw/queue/processing \
             /data/tinyclaw/logs \
             /data/tinyclaw/events \
             /data/tinyclaw/chats \
             /data/tinyclaw/files \
             /data/tinyclaw/workspace \
             /data/whatsapp \
    && chown -R tinyclaw:tinyclaw /data

# No ports exposed (outbound-only connections)

# Health check
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
    CMD [ -f /data/tinyclaw/logs/queue.log ] && [ "$(find /data/tinyclaw/logs/queue.log -mmin -10 2>/dev/null)" ] || exit 1

# Switch to non-root user
USER tinyclaw

# Use dumb-init to handle signals properly and prevent zombie processes
ENTRYPOINT ["/usr/bin/dumb-init", "--"]
CMD ["./docker-entrypoint.sh"]
