# syntax=docker/dockerfile:1
# Build context: repository root (see infra/compose.dev.yaml).
ARG NODE_IMAGE=node:22-alpine

FROM ${NODE_IMAGE} AS base
# HUSKY=0 and --ignore-scripts keep the root "prepare": "husky" hook out of image builds.
ENV PNPM_HOME=/pnpm \
    COREPACK_ENABLE_DOWNLOAD_PROMPT=0 \
    HUSKY=0
ENV PATH=$PNPM_HOME:$PATH
RUN corepack enable
WORKDIR /repo

FROM base AS build
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
RUN pnpm fetch --frozen-lockfile
COPY . .
RUN pnpm install --offline --frozen-lockfile --ignore-scripts --filter @rootcamp/api...
# `...` builds workspace dependencies first (topological order): the deployed api
# loads them from their dist/ via package.json exports.
RUN pnpm --filter "@rootcamp/api..." build
RUN pnpm --filter @rootcamp/api deploy --prod --ignore-scripts /out
# Course content (R-M3-3): tools/content-build writes content-dist/{public,server}/<hash>/ and
# prints `version <hash>`. The api image carries only server/ (full manifests, practice
# scripts); the web image builds the same sources into the same hash and carries only public/.
# CONTENT_EXTRA (e2e only, infra/compose.e2e.yaml): one more content root for `--extra`, e.g.
# e2e/fixtures/content; the web image must get the same value or the hashes differ.
ARG CONTENT_EXTRA=
RUN pnpm content:build ${CONTENT_EXTRA:+--extra "$CONTENT_EXTRA"}

FROM ${NODE_IMAGE} AS runtime
ENV NODE_ENV=production \
    PORT=3000 \
    CONTENT_DIR=/app/content-dist
WORKDIR /app
COPY --from=build --chown=node:node /out ./
COPY --from=build --chown=node:node /repo/content-dist/server ./content-dist/server
USER node
EXPOSE 3000
CMD ["node", "dist/server.js"]
