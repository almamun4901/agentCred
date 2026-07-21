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

COPY demo-agents/agent-a demo-agents/agent-a
RUN pnpm --filter @agent-cred/agent-a build \
    && pnpm --filter @agent-cred/agent-a deploy --prod --legacy /opt/agent-a

FROM node:22-alpine@sha256:16e22a550f3863206a3f701448c45f7912c6896a62de43add43bb9c86130c3e2 AS runtime

ENV NODE_ENV=production
WORKDIR /app

RUN addgroup -S -g 10001 agentcred \
    && adduser -S -D -H -u 10001 -G agentcred agentcred

COPY --from=build --chown=10001:10001 /opt/agent-a ./

USER 10001:10001
CMD ["node", "dist/index.js"]
