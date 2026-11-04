# syntax=docker/dockerfile:1
# Particull: Node's built-in http and sqlite modules, no npm packages to install.
# The server starts as root just long enough to hand /data to PUID:PGID, then switches to that user.
FROM node:22-alpine
ENV NODE_ENV=production \
    PORT=8080 \
    DATA_DIR=/data \
    PUID=1000 \
    PGID=1000
RUN apk add --no-cache tzdata
WORKDIR /app
COPY app/package.json app/*.js ./
COPY app/public ./public
RUN mkdir -p /data
EXPOSE 8080
VOLUME ["/data"]
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD wget -qO- "http://127.0.0.1:${PORT}/api/health" > /dev/null || exit 1
LABEL org.opencontainers.image.title="Particull" \
      org.opencontainers.image.description="A simple parts inventory for makers that checks project BOMs against what you have." \
      org.opencontainers.image.source="https://github.com/au12/particull" \
      org.opencontainers.image.licenses="GPL-3.0"
CMD ["node", "--disable-warning=ExperimentalWarning", "server.js"]
