# TQQQ Recovery — no npm dependencies; Node's built-in sqlite needs Node 22.13+.
FROM node:22-alpine
WORKDIR /app
COPY package.json build.mjs template.html tsconfig.json ./
COPY src ./src
COPY server ./server
RUN node --disable-warning=ExperimentalWarning build.mjs && rm -rf src server build.mjs template.html
ENV NODE_ENV=production DATA_DIR=/data PORT=8080 HOST=0.0.0.0
VOLUME ["/data"]
EXPOSE 8080
USER node
HEALTHCHECK --interval=60s --timeout=5s CMD wget -qO- http://127.0.0.1:8080/healthz || exit 1
CMD ["node", "--disable-warning=ExperimentalWarning", "dist/site/server.mjs"]
