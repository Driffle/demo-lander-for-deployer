FROM node:22-alpine AS deps
WORKDIR /app
COPY package.json package-lock.json* ./
RUN npm ci --omit=dev 2>/dev/null || npm install --omit=dev

FROM node:22-alpine
WORKDIR /app
ENV NODE_ENV=production
# Safe defaults for local compose without platform Vector; override when on deployer_platform + observability.
ENV OTEL_METRICS_EXPORTER=none
ENV OTEL_TRACES_EXPORTER=none
ENV OTEL_LOGS_EXPORTER=none
COPY --from=deps /app/node_modules ./node_modules
COPY package.json ./
COPY server.js ./
COPY scripts/redis-demo-counter.js ./scripts/redis-demo-counter.js
EXPOSE 3000
CMD ["node", "--import", "@opentelemetry/auto-instrumentations-node/register", "server.js"]
