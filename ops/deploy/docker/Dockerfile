# VeeTrax server image: one image for the API, gateway, processor, notifier and summarizer (each container picks its
# command in docker-compose.yml). Also contains the built web app (apps/web/dist) for the proxy.
# Build from the repository root:  docker build -f ops/deploy/docker/Dockerfile -t veetrax:latest .
# EXAMPLE: not yet used in production; test on a staging server first.

FROM node:24-bookworm-slim AS build
WORKDIR /app
RUN apt-get update && apt-get install -y --no-install-recommends openssl ca-certificates && rm -rf /var/lib/apt/lists/*
COPY . .
RUN npm ci --no-audit --no-fund \
 && npm run build:shared \
 && npm run build -w @veetracer/web \
 && cd apps/api && npx prisma generate && npm run build

FROM node:24-bookworm-slim
WORKDIR /app
RUN apt-get update && apt-get install -y --no-install-recommends openssl ca-certificates && rm -rf /var/lib/apt/lists/*
ENV NODE_ENV=production
COPY --from=build /app /app
WORKDIR /app/apps/api
# Default: the API. docker-compose.yml overrides the command for the other processes.
CMD ["node", "--max-old-space-size=512", "dist/main.js"]
