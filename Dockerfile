# syntax=docker/dockerfile:1

FROM node:24-slim AS deps
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci

FROM deps AS web
COPY . .
RUN npm run build

FROM node:24-slim AS prod-deps
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev

FROM oven/bun:1.4.2-slim
WORKDIR /app
# Production also needs CODEDUCKY_PUBLIC_URL and the GitHub OAuth App (CODEDUCKY_GITHUB_CLIENT_ID and
# CODEDUCKY_GITHUB_CLIENT_SECRET) at run time; CODEDUCKY_ADMIN_PASSPHRASE enables admin sign-in.
ENV NODE_ENV=production \
    PORT=8787 \
    DATA_DIR=/data \
    WEB_DIST=/app/dist
COPY --from=prod-deps /app/node_modules node_modules/
COPY package.json ./
COPY shared/ shared/
COPY server/ server/
COPY --from=web /app/dist dist/
# A fresh named volume mounted here takes this directory's owner.
RUN mkdir -p /data && chown bun:bun /data
USER bun
EXPOSE 8787
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s \
  CMD ["bun", "-e", "const r = await fetch(`http://127.0.0.1:${process.env.PORT}/api/health`); process.exit(r.ok ? 0 : 1)"]
CMD ["bun", "server/index.ts"]
