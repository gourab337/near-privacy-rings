# Build from the repo root:  docker build -f relayer/Dockerfile -t npr-relayer .
FROM node:24-slim
WORKDIR /app
COPY sdk/package.json sdk/package-lock.json sdk/
RUN cd sdk && npm ci --omit=dev
COPY sdk/src sdk/src
COPY package.json ./
COPY relayer relayer
ENV PORT=8787
EXPOSE 8787
USER node
CMD ["node", "relayer/server.ts"]
