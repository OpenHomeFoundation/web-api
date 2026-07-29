# syntax=docker/dockerfile:1.25

# Both stages pin the same digest, so a build is reproducible and a tag that
# moves under us cannot change what we ship. It is the multi-platform index
# digest rather than a single manifest, which is what keeps the release build's
# linux/amd64 and linux/arm64 targets working. Renovate keeps it current, on a
# 1-day cooldown rather than the 7 days other updates wait, since a digest bump
# is how this image's security patches arrive.
FROM node:24-alpine@sha256:a0b9bf06e4e6193cf7a0f58816cc935ff8c2a908f81e6f1a95432d679c54fbfd AS builder
WORKDIR /app
RUN corepack enable
# HUSKY=0 disables the `prepare` hook: git hooks are a developer-machine
# concern, and .husky/ is not part of the build context.
ENV HUSKY=0
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
RUN pnpm install --frozen-lockfile
# tsconfig.build.json is what keeps *.spec.ts out of dist; without it nest build
# falls back to tsconfig.json and compiles the test suite into the image.
COPY tsconfig.json tsconfig.build.json nest-cli.json ./
COPY src ./src
RUN pnpm run build

FROM node:24-alpine@sha256:a0b9bf06e4e6193cf7a0f58816cc935ff8c2a908f81e6f1a95432d679c54fbfd AS runner
WORKDIR /app
ENV NODE_ENV=production
ENV PORT=3000
RUN corepack enable
# version.json is produced by the release workflow; the trailing glob keeps a
# plain local `docker build` working when the file is absent.
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml version.json* ./
# --ignore-scripts: husky is a devDependency, so the `prepare` hook that installs
# git hooks for developers cannot run here — and a production image has no
# business running dependency install scripts anyway.
RUN pnpm install --prod --frozen-lockfile --ignore-scripts && \
    chown -R node:node /app
COPY --from=builder --chown=node:node /app/dist ./dist
USER node
EXPOSE 3000
# Container self-health check: __heartbeat__ is the application-level probe
# (__lbheartbeat__ is reserved for the load balancer).
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD wget -q -O- "http://127.0.0.1:${PORT}/__heartbeat__" || exit 1
CMD ["node", "dist/main"]
