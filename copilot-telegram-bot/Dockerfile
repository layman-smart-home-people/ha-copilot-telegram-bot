ARG BUILD_FROM=ghcr.io/home-assistant/aarch64-base-debian:bookworm
FROM ${BUILD_FROM}

# Install Node.js and jq
RUN apt-get update \
    && apt-get install -y --no-install-recommends nodejs npm jq \
    && apt-get clean \
    && rm -rf /var/lib/apt/lists/*

# Create app directory
WORKDIR /app

# Copy package files and install dependencies
COPY package.json ./
RUN npm install --production

# Copy source
COPY src/ ./src/

# Copy rootfs
COPY rootfs /

# Labels
LABEL \
    io.hass.name="Copilot Telegram Bot" \
    io.hass.description="Always-on Telegram bot for GitHub Copilot CLI" \
    io.hass.type="addon" \
    io.hass.version="${BUILD_VERSION}"
