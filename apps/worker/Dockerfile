FROM node:22.23.2-bookworm-slim
WORKDIR /app
ENV NODE_ENV=production
ENV PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1
COPY package.json pnpm-workspace.yaml pnpm-lock.yaml .npmrc ./
COPY apps/worker/package.json apps/worker/package.json
COPY packages/config/package.json packages/config/package.json
COPY packages/domain/package.json packages/domain/package.json
COPY packages/schemas/package.json packages/schemas/package.json
RUN corepack enable && corepack prepare pnpm@12.4.1 --activate && pnpm install --frozen-lockfile --filter @job-to-invoice/worker...
COPY . .
WORKDIR /app/apps/worker
ENV PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=
RUN pnpm exec playwright install --with-deps chromium
CMD ["node", "--experimental-strip-types", "src/index.ts"]
