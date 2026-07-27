# ── Stage 1: Build ────────────────────────────────────────────────────────────
# Build context must be the monorepo root:
#   docker build -f companion/Dockerfile -t simplefin-sync:local .
FROM node:22-alpine@sha256:16e22a550f3863206a3f701448c45f7912c6896a62de43add43bb9c86130c3e2 AS builder
WORKDIR /build

# Install dependencies first so Docker caches this layer separately from source
COPY companion/package*.json ./companion/
RUN cd companion && npm ci

# Copy source files
COPY companion/src/       ./companion/src/
COPY companion/tsconfig.json ./companion/
COPY shared/              ./shared/

# Compile TypeScript
# Output lands at companion/dist/{companion/src/*.js,shared/*.js}
RUN cd companion && npm run build

# ── Stage 2: Production image ─────────────────────────────────────────────────
FROM node:22-alpine@sha256:16e22a550f3863206a3f701448c45f7912c6896a62de43add43bb9c86130c3e2
WORKDIR /app

# Copy compiled output from builder
COPY --from=builder /build/companion/dist/ ./dist/

# Install production dependencies only
COPY companion/package*.json ./
RUN npm ci --omit=dev

# Give the non-root node user write access to /app so it can persist state.json,
# and pre-create /data so the named volume mounted there inherits node ownership
# (STATE_FILE=/data/state.json holds the claimed SimpleFin credentials)
RUN chown -R node:node /app && mkdir -p /data && chown node:node /data

USER node

# Entry point: dist/companion/src/index.js
# (rootDir=".." in companion/tsconfig.json maps companion/src/ → dist/companion/src/)
CMD ["node", "dist/companion/src/index.js"]
