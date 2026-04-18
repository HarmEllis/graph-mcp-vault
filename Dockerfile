# ── Build stage ───────────────────────────────────────────────────────────────
FROM node:24-slim AS build

RUN apt-get update && apt-get upgrade -y && rm -rf /var/lib/apt/lists/*

RUN corepack enable && corepack prepare pnpm@latest --activate

WORKDIR /app

COPY package.json pnpm-lock.yaml ./
RUN pnpm install --frozen-lockfile

COPY tsconfig.json ./
COPY src ./src
RUN pnpm build && cp src/server-instructions.md dist/src/server-instructions.md

# ── Production stage ──────────────────────────────────────────────────────────
FROM node:24-slim AS final

RUN apt-get update && apt-get upgrade -y && rm -rf /var/lib/apt/lists/*

RUN corepack enable && corepack prepare pnpm@latest --activate

WORKDIR /app

COPY package.json pnpm-lock.yaml ./
RUN pnpm install --frozen-lockfile --prod

COPY --from=build /app/dist ./dist

EXPOSE 8000

HEALTHCHECK --interval=10s --timeout=5s --retries=6 --start-period=10s \
  CMD node -e "fetch('http://localhost:8000/.well-known/oauth-authorization-server').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "dist/src/main.js"]
