# syntax=docker/dockerfile:1.7

FROM node:22.18.0-bookworm-slim@sha256:752ea8a2f758c34002a0461bd9f1cee4f9a3c36d48494586f60ffce1fc708e0e AS toolchain
ENV PNPM_HOME=/pnpm
ENV PATH=/pnpm:$PATH
WORKDIR /workspace
RUN corepack enable && corepack prepare pnpm@11.15.0 --activate

FROM toolchain AS dependencies
COPY . .
RUN pnpm install --frozen-lockfile --ignore-scripts

FROM dependencies AS build
RUN pnpm build
RUN pnpm --config.ignore-scripts=true --filter @payops/api deploy --prod --legacy /out/api \
  && pnpm --config.ignore-scripts=true --filter @payops/worker deploy --prod --legacy /out/worker \
  && pnpm --config.ignore-scripts=true --filter @payops/platform deploy --prod --legacy /out/migrate \
  && rm -rf /out/api/src /out/api/test /out/worker/src /out/worker/test /out/migrate/src /out/migrate/test \
  && find /out -type d -path '*/node_modules/@payops/*/src' -prune -exec rm -rf '{}' + \
  && find /out -type d -path '*/node_modules/@payops/*/test' -prune -exec rm -rf '{}' +

FROM node:22.18.0-bookworm-slim@sha256:752ea8a2f758c34002a0461bd9f1cee4f9a3c36d48494586f60ffce1fc708e0e AS runtime
ARG PAYOPS_BUILD_REVISION
RUN node -e "if (!/^[0-9a-f]{40}$/.test(process.argv[1])) process.exit(1)" "$PAYOPS_BUILD_REVISION"
LABEL org.opencontainers.image.source="https://github.com/GautamBytes/solana-payment-ops"
LABEL org.opencontainers.image.revision=$PAYOPS_BUILD_REVISION
ENV NODE_ENV=production
WORKDIR /workspace

FROM runtime AS payops-api
COPY --from=build --chown=10001:10001 /out/api/ /workspace/apps/api/
EXPOSE 3000
STOPSIGNAL SIGTERM
USER 10001:10001
CMD ["node", "apps/api/dist/bin.js"]

FROM runtime AS payops-worker
COPY --from=build --chown=10001:10001 /out/worker/ /workspace/apps/worker/
STOPSIGNAL SIGTERM
USER 10001:10001
CMD ["node", "apps/worker/dist/bin.js"]

FROM runtime AS payops-web
COPY --from=build --chown=10001:10001 /workspace/apps/web/.next/standalone/ /workspace/
COPY --from=build --chown=10001:10001 /workspace/apps/web/.next/static/ /workspace/apps/web/.next/static/
EXPOSE 3001
STOPSIGNAL SIGTERM
USER 10001:10001
CMD ["node", "apps/web/server.js"]

FROM runtime AS payops-migrate
COPY --from=build --chown=10001:10001 /out/migrate/ /workspace/packages/platform/
COPY --from=build --chown=10001:10001 /workspace/packages/ingestion/migrations/ /workspace/packages/ingestion/migrations/
COPY --from=build --chown=10001:10001 /workspace/packages/webhooks/migrations/ /workspace/packages/webhooks/migrations/
COPY --from=build --chown=10001:10001 /workspace/packages/reconciliation/migrations/ /workspace/packages/reconciliation/migrations/
COPY --from=build --chown=10001:10001 /workspace/packages/platform/migrations/ /workspace/packages/platform/migrations/
STOPSIGNAL SIGTERM
USER 10001:10001
CMD ["node", "packages/platform/dist/bin.js", "migrate-hosted"]
