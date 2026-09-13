# syntax=docker/dockerfile:1
# The backend API only. frontend/ deploys separately (Vercel), and backend/worker is still a stub.
FROM node:24-alpine AS base
WORKDIR /app
# pinned to the root package.json's packageManager rather than via corepack,
# which is deprecated and removed in newer Node majors
RUN npm install --global pnpm@11.19.0

FROM base AS build
# manifests first, so editing a source file reuses the install layer
COPY pnpm-lock.yaml pnpm-workspace.yaml package.json tsconfig.base.json ./
COPY shared/contracts/package.json shared/contracts/
COPY backend/dhis2-client/package.json backend/dhis2-client/
COPY backend/api/package.json backend/api/
RUN pnpm install --frozen-lockfile --filter "@dhis-sync/api..."
COPY shared/contracts shared/contracts
COPY backend/dhis2-client backend/dhis2-client
COPY backend/api backend/api
# "@dhis-sync/api..." is the API plus its workspace dependencies, in topological order
RUN pnpm --filter "@dhis-sync/api..." build

FROM base AS runtime
ENV NODE_ENV=production
COPY pnpm-lock.yaml pnpm-workspace.yaml package.json ./
COPY shared/contracts/package.json shared/contracts/
COPY backend/dhis2-client/package.json backend/dhis2-client/
COPY backend/api/package.json backend/api/
RUN pnpm install --frozen-lockfile --prod --filter "@dhis-sync/api..."
# the workspace packages resolve "import" to dist/index.js, so only the built output ships
COPY --from=build /app/shared/contracts/dist shared/contracts/dist
COPY --from=build /app/backend/dhis2-client/dist backend/dhis2-client/dist
COPY --from=build /app/backend/api/dist backend/api/dist
USER node
EXPOSE 4000
CMD ["node", "backend/api/dist/main.js"]
