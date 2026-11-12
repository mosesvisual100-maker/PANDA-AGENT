# Koyeb (and Fly / any container host) build from this.
# Render does not need it — Render runs Node directly.
FROM node:20-alpine

WORKDIR /app

# Dependencies first so the layer caches across code changes.
COPY package*.json ./
RUN npm install --omit=dev

COPY server.js ./

ENV NODE_ENV=production
EXPOSE 3000

# Node is PID 1 here; it must handle SIGTERM itself, which Express+listen does by default.
CMD ["node", "server.js"]
