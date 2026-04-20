FROM node:22-alpine
WORKDIR /app
COPY package.json package-lock.json* ./
RUN npm ci --omit=dev
COPY bot.js .
RUN mkdir -p /data && chmod 777 /data
CMD ["node", "--max-old-space-size=64", "bot.js"]
