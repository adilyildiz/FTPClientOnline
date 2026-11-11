# Multi-stage production Dockerfile for Cloud Run
FROM node:22-alpine AS runner

WORKDIR /app

ENV NODE_ENV=production
ENV PORT=8080

COPY package*.json ./

RUN npm ci --only=production

COPY . .

EXPOSE 8080

USER node

CMD ["node", "server.js"]

