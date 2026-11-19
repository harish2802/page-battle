# Page Battle container image. Needs Node >= 22.13 (built-in node:sqlite).
FROM node:22-slim
WORKDIR /app
ENV NODE_ENV=production
COPY package*.json ./
RUN npm ci --omit=dev
COPY server ./server
COPY public ./public
RUN mkdir -p /data && chown -R node:node /data /app
ENV DATABASE_PATH=/data/page-battle.sqlite PORT=3000 TRUST_PROXY=1
VOLUME /data
USER node
EXPOSE 3000
CMD ["node", "--disable-warning=ExperimentalWarning", "server/index.js"]
