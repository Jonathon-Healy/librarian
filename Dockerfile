FROM node:20-alpine

WORKDIR /app

COPY package.json ./
RUN npm install --omit=dev && npm cache clean --force

COPY server ./server
COPY public ./public

ENV NODE_ENV=production \
    CONFIG_DIR=/config \
    PORT=8787 \
    PUID=99 \
    PGID=100

VOLUME ["/config"]
EXPOSE 8787

HEALTHCHECK --interval=60s --timeout=5s --start-period=10s \
  CMD wget -q -O /dev/null http://127.0.0.1:8787/api/status || exit 1

CMD ["node", "server/index.js"]
