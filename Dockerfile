# syntax=docker/dockerfile:1.25

FROM node:24-alpine AS builder
WORKDIR /app
RUN corepack enable
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
RUN pnpm install --prod --frozen-lockfile && \
    chown -R node:node /app
COPY --from=builder --chown=node:node /app/dist ./dist
USER node
EXPOSE 3000
# Container self-health check: __heartbeat__ is the application-level probe
# (__lbheartbeat__ is reserved for the load balancer).
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD wget -q -O- "http://127.0.0.1:${PORT}/__heartbeat__" || exit 1
CMD ["node", "dist/main"]
