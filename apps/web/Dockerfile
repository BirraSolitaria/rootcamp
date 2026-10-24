# syntax=docker/dockerfile:1
# Build context: repository root (see infra/compose.dev.yaml).
# The resulting image is Caddy with the built SPA in /srv (spec §11.1: web = Caddy + web-dist)
# and the public part of the course in /content-dist/public/<hash>/, served as /content/<hash>/
# (the server part never enters this image, R-M3-3).
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
RUN pnpm install --offline --frozen-lockfile --ignore-scripts --filter @rootcamp/web... --filter content-build...
RUN pnpm --filter @rootcamp/web build
# Same sources as the api image → same hash; only the public part goes into this image.
# CONTENT_EXTRA: as in apps/api/Dockerfile (e2e fixtures; same value for both images).
ARG CONTENT_EXTRA=
RUN pnpm content:build ${CONTENT_EXTRA:+--extra "$CONTENT_EXTRA"}

FROM ${CADDY_IMAGE} AS runtime
COPY --from=build /repo/apps/web/dist /srv
COPY --from=build /repo/content-dist/public /content-dist/public
