# Multi-stage build: compiles the engine and rail service inside the image,
# so `fly deploy` works from a clean clone with no local pre-build step.
#
# Repository layout (engine at repo root, rail/ service):
#   /package.json, /src/, /tsconfig.json   -> engine (@payload/flow-rail)
#   /rail/package.json, /rail/src/         -> rail service
# The rail's file:.. dependency resolves to the repo root.
#
# Build context is the repo root.
# Validate locally with the same context Fly uses:
#   docker build -f rail/Dockerfile -t payload-rail:local .

# ---------- builder ----------
FROM node:20-slim AS builder
WORKDIR /build

# Manifests first for layer caching. Engine lives at the build root so
# rail's file:.. dependency resolves correctly.
COPY package.json package-lock.json* ./
COPY rail/package.json rail/package-lock.json* ./rail/

# Full installs (dev deps needed for tsc).
RUN npm ci --no-audit --no-fund (dev deps needed for tsc).
RUN npm ci --no-audit --no-fund
RUN cd rail && npm ci --no-audit --no-fund

# Sources.
COPY src/ ./src/
COPY tsconfig.json ./
COPY rail/ ./rail/
# Extract vendored v2 runtime (shipped as tarball).
RUN cd rail/src && tar -xzf vendor.tgz && rm vendor.tgz

# Compile engine, then rail.
RUN npm run build (rail build vendors src/vendor -> dist/vendor).
RUN npm run build
RUN cd rail && npm run build

# ---------- runtime ----------
FROM node:20-slim
# Engine lives at the filesystem root so rail's file:.. dependency
# (from /app) resolves to / correctly.
WORKDIR /app

COPY rail/package.json rail/package-lock.json ./
COPY package.json /package.json
COPY --from=builder /build/dist /dist

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
