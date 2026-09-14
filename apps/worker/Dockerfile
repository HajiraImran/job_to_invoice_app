FROM node:22.23.2-bookworm-slim
WORKDIR /app
ENV NODE_ENV=production
COPY package.json pnpm-workspace.yaml pnpm-lock.yaml .npmrc ./
COPY apps/worker/package.json apps/worker/package.json
COPY packages/config/package.json packages/config/package.json
RUN corepack enable && corepack prepare pnpm@12.4.1 --activate && pnpm install --frozen-lockfile --filter @job-to-invoice/worker...
COPY . .
WORKDIR /app/apps/worker
CMD ["node", "--experimental-strip-types", "src/index.ts"]
