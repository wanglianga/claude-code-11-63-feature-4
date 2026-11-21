# Multi-stage build: compile the SPA with the pinned Node runtime, serve the
# static output from nginx. Nothing here talks to a server; the resulting image
# is a plain static-file host, and all processing happens in the visitor's
# browser.

FROM node:22.14.0-bookworm AS build
WORKDIR /app

# Use the same mirror the workspace is configured for.
ENV NPM_CONFIG_REGISTRY=https://registry.npmmirror.com
ENV NPM_CONFIG_FUND=false
ENV NPM_CONFIG_AUDIT=false

COPY package.json package-lock.json* ./
RUN npm install --no-audit --no-fund

COPY . .
RUN npm run build

FROM nginx:1.27-alpine AS runtime
# Worker scripts and the app both need module MIME types; the default nginx
# types cover .js and .mjs, and the font/zip assets are served as-is.
COPY --from=build /app/dist /usr/share/nginx/html
COPY docker/nginx.conf /etc/nginx/conf.d/default.conf
EXPOSE 80
HEALTHCHECK --interval=30s --timeout=3s CMD wget -qO- http://127.0.0.1/ >/dev/null || exit 1
