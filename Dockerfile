# ── Stage 1: Install dependencies ─────────────────────────────
FROM node:22-slim AS deps
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --no-audit --no-fund

# ── Stage 2: Production image ────────────────────────────────
FROM node:22-slim AS runner
WORKDIR /app

ENV NODE_ENV=production
ENV PORT=8002

# Install Chromium system dependencies for Puppeteer
RUN apt-get update && apt-get install -y --no-install-recommends \
    ca-certificates \
    curl \
    fonts-liberation \
    libappindicator3-1 \
    libasound2 \
    libatk-bridge2.0-0 \
    libatk1.0-0 \
    libcups2 \
    libdbus-1-3 \
    libdrm2 \
    libgbm1 \
    libgtk-3-0 \
    libnspr4 \
    libnss3 \
    libx11-xcb1 \
    libxcomposite1 \
    libxdamage1 \
    libxrandr2 \
    xdg-utils \
    libxss1 \
    libfreetype6 \
    libharfbuzz0b \
    wget \
  && rm -rf /var/lib/apt/lists/*

# Create non-root user
RUN groupadd --system --gid 1001 appuser && \
    useradd --system --uid 1001 --gid appuser appuser

# Copy node_modules from deps stage
COPY --from=deps /app/node_modules ./node_modules

# Copy application code
COPY . .

# Create required directories
RUN mkdir -p app/storage/logs app/storage/internal app/storage/invoices app/uploads && \
    chown -R appuser:appuser /app

USER appuser

EXPOSE 8002

HEALTHCHECK --interval=10s --timeout=5s --start-period=45s --retries=3 \
  CMD curl -sf http://localhost:8002/api/health || exit 1

CMD ["node", "--import", "./otel-instrument.mjs", "server.js"]
