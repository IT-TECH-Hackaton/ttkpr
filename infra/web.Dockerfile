# Builds viewer + studio and serves them (and proxies /api, serves /media) with Caddy.
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
# Public origin for share links and QR codes (viewer at /, studio at /studio/). Empty: the
# origin the studio was opened at.
ARG VITE_PUBLIC_URL=
ENV VITE_PUBLIC_URL=$VITE_PUBLIC_URL
RUN pnpm --filter @ttkpr/viewer --filter @ttkpr/studio build
# Content-Security-Policy with the hashes of exactly the inline scripts this build produced,
# then brotli 11 / gzip 9 copies of every text asset (Caddy serves them as they are).
RUN node infra/web/csp.mjs apps/viewer/dist/index.html apps/studio/dist/index.html > csp.caddy \
    && node infra/web/precompress.mjs apps/viewer/dist apps/studio/dist

FROM caddy:2-alpine
COPY infra/Caddyfile /etc/caddy/Caddyfile
COPY --from=build /repo/csp.caddy /etc/caddy/csp.caddy
COPY --from=build /repo/apps/viewer/dist /srv/viewer
COPY --from=build /repo/apps/studio/dist /srv/studio
