ARG BUILD_FROM=ghcr.io/home-assistant/aarch64-base-debian:bookworm
FROM ${BUILD_FROM}

# Install Node.js 22 (LTS) from NodeSource, Python venv support, and jq
RUN apt-get update \
    && apt-get install -y --no-install-recommends ca-certificates curl gnupg git jq python3-venv \
    && curl -fsSL https://deb.nodesource.com/setup_22.x | bash - \
    && apt-get install -y --no-install-recommends nodejs \
    && apt-get clean \
    && rm -rf /var/lib/apt/lists/*

# Create app directory
WORKDIR /app

# Copy package files and install dependencies
COPY package.json ./
RUN npm install --production

# Copy source (cache-bust: update this comment on each rebuild)
# Build: 2026-06-05T21:30
COPY src/ ./src/

# Build Web UI frontend (React + Vite)
RUN cd /app/src/webui/frontend && npm install && npm run build && rm -rf node_modules

# Copy config.yaml and CHANGELOG.md for runtime access
COPY config.yaml CHANGELOG.md ./

# Copy rootfs
COPY rootfs /

# Labels
LABEL \
    io.hass.name="Copilot Telegram Bot" \
    io.hass.description="Always-on Telegram bot for GitHub Copilot CLI" \
    io.hass.type="addon" \
    io.hass.version="${BUILD_VERSION}" \
    org.opencontainers.image.title="Copilot Telegram Bot" \
    org.opencontainers.image.description="Always-on Telegram bot connected to GitHub Copilot CLI via ACP" \
    org.opencontainers.image.source="https://github.com/layman-smart-home-people/ha-copilot-telegram-bot" \
    org.opencontainers.image.licenses="MIT"
