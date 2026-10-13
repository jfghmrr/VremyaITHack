FROM node:22-alpine AS build
WORKDIR /site
COPY package.json package-lock.json ./
RUN npm ci
COPY . .
RUN npm test && npm run test:server && npm run build

FROM nginx:stable-alpine AS website
COPY docker/nginx.conf /etc/nginx/conf.d/default.conf
COPY --from=build /site/dist /usr/share/nginx/html
EXPOSE 80
HEALTHCHECK --interval=30s --timeout=3s --start-period=5s --retries=3 \
  CMD wget -q -O /dev/null http://127.0.0.1/healthz || exit 1

FROM node:22-alpine AS api
WORKDIR /site
COPY package.json package-lock.json ./
RUN npm ci --omit=dev
COPY server ./server
RUN mkdir /data && chown node:node /data
USER node
ENV HOST=0.0.0.0 PORT=3001 DB_PATH=/data/perepev.sqlite
EXPOSE 3001
HEALTHCHECK --interval=30s --timeout=3s --start-period=5s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:3001/api/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["node", "server/start.mjs"]
