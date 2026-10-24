# syntax=docker/dockerfile:1
# Build context: repository root.
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
RUN pnpm install --offline --frozen-lockfile --ignore-scripts --filter @rootcamp/sandboxd...
# `...` builds workspace dependencies first (topological order): the deployed sandboxd
# loads them from their dist/ via package.json exports.
RUN pnpm --filter "@rootcamp/sandboxd..." build
RUN pnpm --filter @rootcamp/sandboxd deploy --prod --ignore-scripts /out

FROM ${NODE_IMAGE} AS runtime
ENV NODE_ENV=production \
    PORT=3001
WORKDIR /app
COPY --from=build /out ./
# Runs as root: it talks to the mounted /var/run/docker.sock (root:docker on the host) and
# reads /host/proc, /host/root. It is the only service with that socket (spec §3.1).
EXPOSE 3001
CMD ["node", "dist/server.js"]
