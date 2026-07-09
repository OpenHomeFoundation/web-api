# syntax=docker/dockerfile:1.25

FROM node:24-alpine AS builder
WORKDIR /app
RUN corepack enable
# minimumReleaseAge in pnpm-workspace.yaml re-checks every lockfile entry's
# publish date on install AND before running scripts (deps status check), even
# when frozen. That cooldown is a resolution-time guard (local `pnpm add/update`,
# Renovate); this build only reproduces an already-gated, PR-reviewed lockfile,
# so opt out to avoid spurious release-age failures.
ENV PNPM_CONFIG_MINIMUM_RELEASE_AGE=0
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
RUN pnpm install --frozen-lockfile
COPY tsconfig.json nest-cli.json ./
COPY src ./src
RUN pnpm run build

FROM node:24-alpine AS runner
WORKDIR /app
ENV NODE_ENV=production
ENV PORT=3000
RUN corepack enable
# version.json is produced by the release workflow; the trailing glob keeps a
# plain local `docker build` working when the file is absent.
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml version.json* ./
# See the builder stage: opt out of the release-age cooldown for this frozen
# reproduction of an already-gated lockfile. Scoped to the install RUN so the
# shipped image doesn't carry the override (there is no pnpm at runtime anyway).
RUN PNPM_CONFIG_MINIMUM_RELEASE_AGE=0 pnpm install --prod --frozen-lockfile && \
    chown -R node:node /app
COPY --from=builder --chown=node:node /app/dist ./dist
USER node
EXPOSE 3000
# Container self-health check: __heartbeat__ is the application-level probe
# (__lbheartbeat__ is reserved for the load balancer).
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD wget -q -O- "http://127.0.0.1:${PORT}/__heartbeat__" || exit 1
CMD ["node", "dist/main"]
