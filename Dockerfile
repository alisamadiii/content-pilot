FROM node:22-alpine AS base
RUN corepack enable pnpm

FROM base AS build
WORKDIR /app
COPY package.json pnpm-lock.yaml ./
RUN pnpm install --frozen-lockfile
COPY . .
# Build-time placeholders — never connected to; real values come at runtime.
ENV DATABASE_URL=postgres://placeholder:placeholder@localhost:5432/placeholder
ENV BETTER_AUTH_SECRET=build-placeholder
RUN pnpm build

FROM base AS runtime
WORKDIR /app
RUN apk add --no-cache git bash
RUN npm install -g @anthropic-ai/claude-code

RUN addgroup -g 1001 nodejs && adduser -u 1001 -G nodejs -s /bin/sh -D nextjs

# Next standalone server
COPY --from=build --chown=nextjs:nodejs /app/.next/standalone ./
COPY --from=build --chown=nextjs:nodejs /app/.next/static ./.next/static

# Worker + schema sources (run with tsx, no build step)
COPY --from=build --chown=nextjs:nodejs /app/src ./src
COPY --from=build --chown=nextjs:nodejs /app/scripts ./scripts
COPY --from=build --chown=nextjs:nodejs /app/drizzle.config.ts /app/tsconfig.json ./
COPY --from=build --chown=nextjs:nodejs /app/node_modules ./node_modules
COPY --chown=nextjs:nodejs docker/entrypoint.sh ./docker/entrypoint.sh
RUN chmod +x ./docker/entrypoint.sh

RUN mkdir -p /data/workspace && chown -R nextjs:nodejs /data
USER nextjs

ENV NODE_ENV=production
ENV PORT=3010
ENV HOSTNAME=0.0.0.0
ENV WORKSPACE_DIR=/data/workspace

# Preview proxy (wildcard *.preview domain routes here via Traefik)
EXPOSE 3020

EXPOSE 3010
HEALTHCHECK --interval=30s --timeout=5s --start-period=30s \
  CMD wget -qO- http://127.0.0.1:3010/api/health || exit 1

ENTRYPOINT ["./docker/entrypoint.sh"]
