# syntax=docker/dockerfile:1

# ---------------------------------------------------------------------------
# Base: Node 20 LTS plus the postgresql client, so the backup job can shell out
# to pg_dump / pg_restore from inside the container.
# ---------------------------------------------------------------------------
FROM node:20-alpine AS base
WORKDIR /app
RUN apk add --no-cache postgresql16-client tzdata openssl libc6-compat
ENV TZ=UTC

# ---------------------------------------------------------------------------
# Dependencies
# ---------------------------------------------------------------------------
FROM base AS deps
COPY package.json package-lock.json* ./
COPY prisma ./prisma
RUN npm install --no-audit --no-fund

# ---------------------------------------------------------------------------
# Development: hot reload, sources bind-mounted by docker-compose
# ---------------------------------------------------------------------------
FROM base AS development
ENV NODE_ENV=development
COPY --from=deps /app/node_modules ./node_modules
COPY . .
RUN npx prisma generate
EXPOSE 3000
CMD ["npm", "run", "start:dev"]

# ---------------------------------------------------------------------------
# Build
# ---------------------------------------------------------------------------
FROM base AS build
COPY --from=deps /app/node_modules ./node_modules
COPY . .
RUN npx prisma generate && npm run build

# ---------------------------------------------------------------------------
# Production
# ---------------------------------------------------------------------------
FROM base AS production
ENV NODE_ENV=production
COPY package.json package-lock.json* ./
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY --from=build /app/prisma ./prisma
COPY --from=build /app/scripts ./scripts
USER node
EXPOSE 3000
CMD ["node", "dist/main.js"]
