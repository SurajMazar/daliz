# syntax=docker/dockerfile:1.7
# One image, two processes: the HTTP API (default) and the background worker
# (`node dist/worker.js`). Build from the repository root:
#   docker build -f apps/api/Dockerfile -t daliz-api .

FROM node:24-bookworm-slim AS base
ENV PNPM_HOME=/pnpm PATH=/pnpm:$PATH
RUN corepack enable
WORKDIR /repo

FROM base AS build
COPY pnpm-lock.yaml pnpm-workspace.yaml package.json tsconfig.base.json ./
COPY packages/shared/package.json packages/shared/
COPY apps/api/package.json apps/api/
RUN --mount=type=cache,id=pnpm,target=/pnpm/store pnpm install --frozen-lockfile --filter @daliz/api... --child-concurrency=1 --network-concurrency=4
COPY packages/shared packages/shared
COPY apps/api apps/api
# Type-checking happens in CI; the image only transpiles (SWC), which fits small builders.
RUN pnpm --filter @daliz/shared build && pnpm --filter @daliz/api build:transpile
RUN --mount=type=cache,id=pnpm,target=/pnpm/store pnpm --filter @daliz/api deploy --prod --legacy /out \
 && cp -r apps/api/dist apps/api/migrations /out/

FROM node:24-bookworm-slim AS runtime
ENV NODE_ENV=production
WORKDIR /app
COPY --from=build --chown=node:node /out ./
# Never run as root; the filesystem is read-only in production (see compose.prod.yaml).
USER node
EXPOSE 3000
HEALTHCHECK --interval=15s --timeout=3s --retries=5 \
  CMD node -e "fetch('http://127.0.0.1:3000/api/v1/health/live').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["node", "--enable-source-maps", "dist/main.js"]
