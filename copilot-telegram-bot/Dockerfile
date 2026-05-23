ARG BUILD_FROM=ghcr.io/hassio-addons/base:17.2.4
FROM ${BUILD_FROM}

# Install Node.js 20
RUN apk add --no-cache nodejs npm

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
