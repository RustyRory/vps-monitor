FROM node:20-alpine

RUN apk add --no-cache git docker-cli docker-cli-compose \
    && git config --global --add safe.directory '*'

WORKDIR /app

COPY package*.json ./
RUN npm ci --omit=dev

COPY api/ ./api/
COPY public/ ./public/

EXPOSE 3000

CMD ["node", "api/server.js"]
