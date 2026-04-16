FROM node:20-bookworm-slim

ENV DEBIAN_FRONTEND=noninteractive \
    NEXT_TELEMETRY_DISABLED=1 \
    PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    PLAYWRIGHT_BROWSERS_PATH=/ms-playwright-seed \
    PLAYWRIGHT_BROWSERS_SEED_PATH=/ms-playwright-seed

RUN apt-get update \
    && apt-get install -y --no-install-recommends \
      ca-certificates \
      curl \
      dumb-init \
      git \
      python3 \
      python3-pip \
      python3-venv \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY package.json package-lock.json ./
COPY apps/web/package.json apps/web/package.json
RUN npm ci

COPY . .

RUN npm run build:web \
    && python3 -m venv /app/mcp-server/venv \
    && /app/mcp-server/venv/bin/pip install --upgrade pip setuptools wheel \
    && /app/mcp-server/venv/bin/pip install -e /app/mcp-server \
    && python3 -m venv /app/workers/scraper/venv \
    && /app/workers/scraper/venv/bin/pip install --upgrade pip setuptools wheel \
    && /app/workers/scraper/venv/bin/pip install -e /app/workers/scraper \
    && python3 -m venv /app/workers/sender/venv \
    && /app/workers/sender/venv/bin/pip install --upgrade pip setuptools wheel \
    && /app/workers/sender/venv/bin/pip install -e /app/workers/sender \
    && /app/workers/scraper/venv/bin/python -m playwright install --with-deps chromium

RUN chmod +x /app/scripts/container-entrypoint.sh /app/run_all.sh

ENTRYPOINT ["/usr/bin/dumb-init", "--", "/app/scripts/container-entrypoint.sh"]
