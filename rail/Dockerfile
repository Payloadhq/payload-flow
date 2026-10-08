# Multi-stage build: compiles mvp engine and rail service inside the image,
# so `fly deploy` works from a clean clone with no local pre-build step.
#
# Build context is the repo root (products/payload-flow/).
# Validate locally with the same context Fly uses:
#   docker build -f rail/Dockerfile -t payload-rail:local .

# ---------- builder ----------
FROM node:20-slim AS builder
WORKDIR /build

# Manifests first for layer caching.
COPY mvp/package.json mvp/package-lock.json* ./mvp/
COPY rail/package.json rail/package-lock.json* ./rail/

# Full installs (dev deps needed for tsc).
RUN cd mvp && npm ci --no-audit --no-fund
RUN cd rail && npm ci --no-audit --no-fund

# Sources. The file:../mvp link resolves because the repo layout is
# preserved (/build/rail -> ../mvp == /build/mvp).
COPY mvp/ ./mvp/
COPY rail/ ./rail/

# Compile. rail build also vendors rail/src/vendor -> dist/vendor.
RUN cd mvp && npm run build
RUN cd rail && npm run build

# ---------- runtime ----------
FROM node:20-slim
WORKDIR /app

COPY rail/package.json rail/package-lock.json ./
COPY mvp/package.json /mvp/package.json
COPY --from=builder /build/mvp/dist /mvp/dist

# better-sqlite3 needs a native build when no prebuilt matches the exact
# node version: install the toolchain, build, then remove it to keep the
# image slim.
RUN apt-get update && apt-get install -y --no-install-recommends python3 make g++ \
  && npm ci --omit=dev --no-audit --no-fund \
  && apt-get purge -y python3 make g++ && apt-get autoremove -y \
  && rm -rf /var/lib/apt/lists/*

COPY --from=builder /build/rail/dist ./dist

RUN useradd --create-home --shell /usr/sbin/nologin rail \
  && mkdir -p /data \
  && chown rail:rail /data
USER rail

ENV PORT=8787
ENV RAIL_DB_PATH=/data/rail.db
EXPOSE 8787

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:8787/health').then(r=>{if(!r.ok)process.exit(1)}).catch(()=>process.exit(1))"

CMD ["node", "dist/index.js"]
