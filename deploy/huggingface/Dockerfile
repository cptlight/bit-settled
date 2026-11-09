# Hugging Face Docker Space for bit-settled.
# Builds directly from the public GitHub repo so this Space stays in sync.
# cache-bust: 2026-11-06 live-sandbox
FROM node:22-alpine

RUN apk add --no-cache git ca-certificates
WORKDIR /app

ARG CACHE_BUST=2026-11-09-autofill-1
RUN echo "cache bust: $CACHE_BUST"

RUN git clone --depth 1 https://github.com/cptlight/bit-settled.git .

ENV NODE_ENV=production \
    HOST=0.0.0.0 \
    PORT=7860

EXPOSE 7860
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s \
  CMD wget -qO- http://127.0.0.1:7860/api/health || exit 1

CMD ["node", "server.js"]
