FROM node:22-alpine
WORKDIR /app
ENV NODE_ENV=production HOST=0.0.0.0 PORT=4173
COPY package.json ./
COPY server.js ./
COPY lib ./lib
COPY mcp ./mcp
COPY public ./public
EXPOSE 4173
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s CMD wget -qO- http://127.0.0.1:4173/api/health || exit 1
CMD ["node", "server.js"]
