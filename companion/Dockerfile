# ── Stage 1: Build ────────────────────────────────────────────────────────────
FROM node:22-alpine AS builder
WORKDIR /build

# Install dependencies first so Docker caches this layer separately from source
COPY companion/package*.json ./companion/
RUN cd companion && npm install --no-audit --no-fund

# Copy source files
COPY companion/src/       ./companion/src/
COPY companion/tsconfig.json ./companion/
COPY shared/              ./shared/

# Compile TypeScript
# Output lands at companion/dist/{companion/src/*.js,shared/*.js}
RUN cd companion && npm run build

# ── Stage 2: Production image ─────────────────────────────────────────────────
FROM node:22-alpine
# ttf-dejavu: resvg renders SVG text as NOTHING without a font on disk —
# live 2026-09-03, every chart photo shipped with no axis labels or legend.
RUN apk add --no-cache sqlite ttf-dejavu
WORKDIR /app

# Copy compiled output from builder
COPY --from=builder /build/companion/dist/ ./dist/

# Install production dependencies only
COPY companion/package*.json ./
RUN npm install --omit=dev --no-audit --no-fund

# Give the non-root node user write access to /app so it can persist state.json,
# and pre-create /data so the named volume mounted there inherits node ownership
# (STATE_FILE=/data/state.json holds the claimed SimpleFin credentials)
RUN chown -R node:node /app && mkdir -p /data && chown node:node /data

USER node

HEALTHCHECK --interval=5m --timeout=10s --start-period=30s \
  CMD node -e "process.exit(0)" || exit 1

# Entry point: dist/companion/src/index.js
# (rootDir=".." in companion/tsconfig.json maps companion/src/ → dist/companion/src/)
CMD ["node", "dist/companion/src/index.js"]
