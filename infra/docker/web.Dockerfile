# syntax=docker/dockerfile:1.7
# Static web app (web + PWA) served by nginx, which also reverse-proxies /api to the API.
#   docker build -f infra/docker/web.Dockerfile -t daliz-web .
FROM node:24-bookworm-slim AS build
ENV PNPM_HOME=/pnpm PATH=/pnpm:$PATH
RUN corepack enable
WORKDIR /repo
COPY pnpm-lock.yaml pnpm-workspace.yaml package.json tsconfig.base.json ./
COPY packages/shared/package.json packages/shared/
COPY apps/web/package.json apps/web/
RUN --mount=type=cache,id=pnpm,target=/pnpm/store pnpm install --frozen-lockfile --filter @daliz/web... --child-concurrency=1 --network-concurrency=4
COPY packages/shared packages/shared
COPY apps/web apps/web
RUN pnpm --filter @daliz/shared build && pnpm --filter @daliz/web build

FROM nginxinc/nginx-unprivileged:1.29-alpine AS runtime
COPY --from=build /repo/apps/web/dist /usr/share/nginx/html
COPY infra/nginx/daliz.conf.template /etc/nginx/templates/default.conf.template
# Rendered at start-up by the image's envsubst entrypoint.
ENV API_UPSTREAM=http://api:3000 S3_PUBLIC_ORIGIN=https://storage.example.com
EXPOSE 8080
