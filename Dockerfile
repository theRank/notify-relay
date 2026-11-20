# syntax=docker/dockerfile:1

# The JavaScript bundle is architecture-independent; build natively to avoid emulation.
FROM --platform=$BUILDPLATFORM node:24-alpine@sha256:116b800c3754b440ee0aa3ed2f20f5bf3d99a554bfd9adeea09ea8017f6e85f5 AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN --mount=type=cache,target=/root/.npm npm ci --ignore-scripts --no-audit --no-fund
COPY tsconfig.json ./
COPY src ./src
RUN npm run build:node

FROM node:24-alpine@sha256:116b800c3754b440ee0aa3ed2f20f5bf3d99a554bfd9adeea09ea8017f6e85f5
WORKDIR /app
COPY --from=build /app/dist/node/index.mjs ./
USER node
ENV PORT=8080
EXPOSE 8080
HEALTHCHECK --interval=30s --timeout=5s --start-period=5s --start-interval=1s \
    CMD wget --quiet --output-document=/dev/null "http://127.0.0.1:$PORT/healthz" || exit 1
CMD ["node", "index.mjs"]
