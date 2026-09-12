# syntax=docker/dockerfile:1
# The API only. apps/web deploys separately (Vercel), and apps/worker is still a stub.
FROM node:24-alpine AS base
WORKDIR /app
# pinned to the root package.json's packageManager rather than via corepack,
# which is deprecated and removed in newer Node majors
RUN npm install --global pnpm@11.19.0

FROM base AS build
# manifests first, so editing a source file reuses the install layer
COPY pnpm-lock.yaml pnpm-workspace.yaml package.json tsconfig.base.json ./
COPY packages/contracts/package.json packages/contracts/
COPY packages/dhis2-client/package.json packages/dhis2-client/
COPY apps/api/package.json apps/api/
RUN pnpm install --frozen-lockfile --filter "@dhis-sync/api..."
COPY packages/contracts packages/contracts
COPY packages/dhis2-client packages/dhis2-client
COPY apps/api apps/api
# "@dhis-sync/api..." is the API plus its workspace dependencies, in topological order
RUN pnpm --filter "@dhis-sync/api..." build

FROM base AS runtime
ENV NODE_ENV=production
COPY pnpm-lock.yaml pnpm-workspace.yaml package.json ./
COPY packages/contracts/package.json packages/contracts/
COPY packages/dhis2-client/package.json packages/dhis2-client/
COPY apps/api/package.json apps/api/
RUN pnpm install --frozen-lockfile --prod --filter "@dhis-sync/api..."
# packages/* resolve "import" to dist/index.js, so only the built output ships
COPY --from=build /app/packages/contracts/dist packages/contracts/dist
COPY --from=build /app/packages/dhis2-client/dist packages/dhis2-client/dist
COPY --from=build /app/apps/api/dist apps/api/dist
USER node
EXPOSE 4000
CMD ["node", "apps/api/dist/main.js"]
