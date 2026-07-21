FROM node:22-alpine@sha256:16e22a550f3863206a3f701448c45f7912c6896a62de43add43bb9c86130c3e2 AS build

ENV PNPM_HOME=/pnpm
ENV PATH=$PNPM_HOME:$PATH
WORKDIR /workspace

RUN corepack enable && corepack prepare pnpm@10.30.1 --activate

COPY package.json pnpm-lock.yaml pnpm-workspace.yaml tsconfig.base.json ./
COPY issuer/package.json issuer/package.json
COPY verifier-sdk/package.json verifier-sdk/package.json
COPY demo-agents/agent-a/package.json demo-agents/agent-a/package.json
COPY demo-agents/agent-b/package.json demo-agents/agent-b/package.json
RUN pnpm install --frozen-lockfile

COPY issuer issuer
COPY verifier-sdk verifier-sdk
RUN pnpm --filter @agent-cred/verifier-sdk build \
    && pnpm --filter @agent-cred/issuer build \
    && pnpm --filter @agent-cred/issuer deploy --prod --legacy /opt/issuer

FROM node:22-alpine@sha256:16e22a550f3863206a3f701448c45f7912c6896a62de43add43bb9c86130c3e2 AS runtime

ENV NODE_ENV=production
ENV HOST=0.0.0.0
ENV PORT=3000
WORKDIR /app

RUN addgroup -S -g 10001 agentcred \
    && adduser -S -D -H -u 10001 -G agentcred agentcred

COPY --from=build --chown=10001:10001 /opt/issuer ./

USER 10001:10001
EXPOSE 3000
HEALTHCHECK --interval=10s --timeout=3s --start-period=10s --retries=5 \
  CMD ["node", "-e", "fetch('http://127.0.0.1:3000/healthz').then(r=>{if(!r.ok)process.exit(1)}).catch(()=>process.exit(1))"]
CMD ["node", "dist/server.js"]

FROM node:22-alpine@sha256:16e22a550f3863206a3f701448c45f7912c6896a62de43add43bb9c86130c3e2 AS key-init

WORKDIR /opt/key-init
COPY issuer/container/init-keys.mjs ./init-keys.mjs

USER 0:0
CMD ["node", "init-keys.mjs"]
