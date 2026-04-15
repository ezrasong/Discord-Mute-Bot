FROM node:22-alpine
WORKDIR /app
COPY package.json package-lock.json* ./
RUN npm ci --omit=dev
COPY bot.js .
RUN mkdir -p /data && chown node:node /data
VOLUME ["/data"]
USER node
CMD ["node", "--max-old-space-size=64", "bot.js"]
