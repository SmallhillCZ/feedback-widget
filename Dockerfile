FROM node:22-alpine

WORKDIR /app
COPY package.json server.js ./
COPY lib ./lib
COPY public ./public
COPY demo ./demo
COPY bin ./bin

RUN mkdir -p /data && chown node:node /data
USER node

ENV NODE_ENV=production \
    PORT=4400 \
    DATA_DIR=/data
VOLUME /data
EXPOSE 4400

HEALTHCHECK --interval=30s --timeout=3s CMD wget -qO- http://127.0.0.1:4400/health || exit 1
CMD ["node", "server.js"]
