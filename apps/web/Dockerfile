# syntax=docker/dockerfile:1
# Build context: repository root (see infra/compose.dev.yaml).
# The resulting image is Caddy with the built SPA in /srv (spec §11.1: web = Caddy + web-dist).
ARG NODE_IMAGE=node:22-alpine
ARG CADDY_IMAGE=caddy:2.10-alpine

FROM ${NODE_IMAGE} AS build
# HUSKY=0 and --ignore-scripts keep the root "prepare": "husky" hook out of image builds.
ENV PNPM_HOME=/pnpm \
    COREPACK_ENABLE_DOWNLOAD_PROMPT=0 \
    HUSKY=0
ENV PATH=$PNPM_HOME:$PATH
RUN corepack enable
WORKDIR /repo
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
RUN pnpm fetch --frozen-lockfile
COPY . .
RUN pnpm install --offline --frozen-lockfile --ignore-scripts --filter @rootcamp/web...
RUN pnpm --filter @rootcamp/web build

FROM ${CADDY_IMAGE} AS runtime
COPY --from=build /repo/apps/web/dist /srv
