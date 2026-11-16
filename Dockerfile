# Soccer Arena Persian — game server image
FROM node:20-alpine

WORKDIR /app
ENV NODE_ENV=production

# server sources (shared physics is bundled inside)
COPY server/package.json ./server/
RUN cd server && npm install --omit=dev

COPY server/src ./server/src
COPY shared ./shared
COPY db ./db
# client single-file build (override with the ./client volume if present)
COPY client ./client

EXPOSE 8080
WORKDIR /app/server
CMD ["node", "src/index.js"]
