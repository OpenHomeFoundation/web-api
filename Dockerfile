# syntax=docker/dockerfile:1.26@sha256:ecfaec9ed6d810b56388c508f4121597bfbba70d41a6dfeee4d8cad5f295fc32

# Every stage pins the same digest, so a build is reproducible and a tag that
# moves under us cannot change what we ship. It is the multi-platform index
# digest rather than a single manifest, which is what keeps the release build's
# linux/amd64 and linux/arm64 targets working. Renovate keeps it current, on a
# 1-day cooldown rather than the 7 days other updates wait, since a digest bump
# is how this image's security patches arrive.

# The two stages that run a command are pinned to $BUILDPLATFORM: they execute
# on whatever architecture the builder itself is, never on an emulated one.
# This is safe because the compiled output is pure JavaScript and so is every
# production dependency, so nothing either stage produces is architecture
# specific. It matters because the release build is multi-platform: left on the
# target platform, these stages run under QEMU, where `pnpm install` has died
# with SIGILL (exit 132) and taken a release with it.
#
# Adding a production dependency with native bindings breaks that assumption
# silently — the image would ship the builder's architecture. Such a dependency
# has to be installed on $TARGETPLATFORM instead, emulation and all.
FROM --platform=$BUILDPLATFORM node:24-alpine@sha256:d32cdf619f63fe0471182d08996dd516c6275bb5fd31ae06e55a570bd9e1ad43 AS builder
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

# Production dependencies are resolved in their own stage rather than by
# pruning the builder's, so the runner copies a tree that never held a
# devDependency.
# --ignore-scripts: husky is a devDependency, so the `prepare` hook that
# installs git hooks for developers cannot run here — and an install whose
# scripts may fetch architecture-specific binaries would defeat the
# build-platform reasoning above.
FROM --platform=$BUILDPLATFORM node:24-alpine@sha256:d32cdf619f63fe0471182d08996dd516c6275bb5fd31ae06e55a570bd9e1ad43 AS deps
WORKDIR /app
ENV HUSKY=0
RUN corepack enable
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
RUN pnpm install --prod --frozen-lockfile --ignore-scripts

# The runner is the only stage built for the target platform, and it runs
# nothing: it copies what the stages above produced. That keeps QEMU out of the
# multi-platform build entirely, and leaves neither pnpm nor its
# content-addressable store in the image the way an install here would.
FROM node:24-alpine@sha256:d32cdf619f63fe0471182d08996dd516c6275bb5fd31ae06e55a570bd9e1ad43 AS runner
WORKDIR /app
ENV NODE_ENV=production
ENV PORT=3000
# version.json is produced by the release workflow; the trailing glob keeps a
# plain local `docker build` working when the file is absent. package.json is
# what /__version__ falls back to when it is (see src/health/version.ts).
COPY --chown=node:node package.json version.json* ./
COPY --from=deps --chown=node:node /app/node_modules ./node_modules
COPY --from=builder --chown=node:node /app/dist ./dist
USER node
EXPOSE 3000
# Container self-health check: __heartbeat__ is the application-level probe
# (__lbheartbeat__ is reserved for the load balancer).
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD wget -q -O- "http://127.0.0.1:${PORT}/__heartbeat__" || exit 1
CMD ["node", "dist/main"]
