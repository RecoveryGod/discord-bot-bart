FROM node:25-alpine

WORKDIR /app

COPY package.json package-lock.json* ./
RUN npm ci --omit=dev

COPY src ./src
COPY data ./data
RUN chown -R node:node /app

USER node

CMD ["node", "src/index.js"]
