# Client Desk: Mastra server (Hono) for Coolify.
FROM node:22-slim AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY . .
ENV MASTRA_TELEMETRY_DISABLED=1
RUN npm run build

FROM node:22-slim
WORKDIR /app
ENV NODE_ENV=production MASTRA_TELEMETRY_DISABLED=1 PORT=4111 HOST=0.0.0.0
COPY --from=build /app/.mastra/output ./.mastra/output
COPY --from=build /app/dist/migrate.mjs ./dist/migrate.mjs
COPY --from=build /app/drizzle ./drizzle
EXPOSE 4111
HEALTHCHECK --interval=30s --timeout=5s CMD node -e "fetch('http://localhost:4111/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
# Migrations are idempotent; run them on every start, then serve.
CMD ["sh", "-c", "node dist/migrate.mjs && node .mastra/output/index.mjs"]
