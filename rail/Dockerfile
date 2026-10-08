FROM node:20-slim

# Build context is products/payload-flow/ (so the file:../mvp engine
# dependency resolves):
#   docker build -f rail/Dockerfile -t payload-rail:v1 .
#
# better-sqlite3 is built from source in the image (prebuilts do not cover
# every node patch version); the toolchain is removed after the build.
WORKDIR /app

COPY rail/package.json rail/package-lock.json ./
COPY mvp/package.json /mvp/package.json
# Engine sources (dist/ is the compiled library entrypoint).
COPY mvp/dist /mvp/dist

# better-sqlite3 needs a native build when no prebuilt matches the exact
# node version: install the toolchain, build, then remove it to keep the
# image slim.
RUN apt-get update && apt-get install -y --no-install-recommends python3 make g++ \
  && npm ci --omit=dev --no-audit --no-fund \
  && apt-get purge -y python3 make g++ && apt-get autoremove -y \
  && rm -rf /var/lib/apt/lists/*

COPY rail/dist ./dist
# Vendored callx402 v2.0.0 diagnostic modules (CJS) for server-side action
# execution. Copied raw; tsc excludes src/vendor (see tsconfig).
COPY rail/src/vendor ./dist/vendor

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
