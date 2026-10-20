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
RUN pnpm --filter @rootcamp/api build
RUN pnpm --filter @rootcamp/api deploy --prod --ignore-scripts /out

FROM ${NODE_IMAGE} AS runtime
ENV NODE_ENV=production \
    PORT=3000
WORKDIR /app
COPY --from=build --chown=node:node /out ./
USER node
EXPOSE 3000
CMD ["node", "dist/server.js"]
