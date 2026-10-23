# Builds viewer + studio and serves them (and proxies /api) with Caddy.
FROM node:24-alpine AS build
RUN npm install -g pnpm@12.15.0
WORKDIR /repo
COPY pnpm-lock.yaml pnpm-workspace.yaml package.json ./
COPY apps/viewer/package.json apps/viewer/package.json
COPY apps/studio/package.json apps/studio/package.json
COPY packages/map-core/package.json packages/map-core/package.json
COPY packages/ui/package.json packages/ui/package.json
COPY packages/api-client/package.json packages/api-client/package.json
RUN pnpm install --frozen-lockfile
COPY . .
# Public origins for share links and QR codes built into the studio.
ARG VITE_VIEWER_URL=https://localhost
ARG VITE_STUDIO_URL=https://studio.localhost
ENV VITE_VIEWER_URL=$VITE_VIEWER_URL VITE_STUDIO_URL=$VITE_STUDIO_URL
RUN pnpm --filter @ttkpr/viewer --filter @ttkpr/studio build

FROM caddy:2-alpine
COPY infra/Caddyfile /etc/caddy/Caddyfile
COPY --from=build /repo/apps/viewer/dist /srv/viewer
COPY --from=build /repo/apps/studio/dist /srv/studio
