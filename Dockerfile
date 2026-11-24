FROM node:22-bookworm-slim AS build
WORKDIR /app
COPY package.json package-lock.json ./
COPY server/package.json server/
COPY webapp/package.json webapp/
RUN npm ci
COPY shared shared
COPY server server
COPY webapp webapp
RUN npm run build -w webapp && npm run build -w server && npm test -w server

FROM node:22-bookworm-slim
WORKDIR /app
ENV NODE_ENV=production
COPY package.json package-lock.json ./
COPY server/package.json server/
COPY webapp/package.json webapp/
RUN npm ci --omit=dev -w server && npm cache clean --force
COPY --from=build /app/server/dist server/dist
COPY --from=build /app/webapp/dist webapp/dist
WORKDIR /app/server
ENV DATABASE_PATH=/app/data/starlight.db WEBAPP_DIST=/app/webapp/dist
VOLUME /app/data
EXPOSE 3000
CMD ["node", "dist/index.js"]
