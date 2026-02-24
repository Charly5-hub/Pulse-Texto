FROM node:22-alpine

WORKDIR /app

COPY package*.json ./
RUN npm ci --omit=dev

COPY . .

EXPOSE 8787

HEALTHCHECK --interval=20s --timeout=5s --start-period=20s --retries=5 \
  CMD wget -qO- "http://127.0.0.1:${PORT:-8787}/api/health" >/dev/null || exit 1

CMD ["node", "server.js"]
