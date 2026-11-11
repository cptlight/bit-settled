# Hugging Face Docker Space for bitsettled.
# Pulls the public GitHub snapshot as a tarball (git clone is unreliable in
# some Space builders). CACHE_BUST forces a fresh snapshot on each deploy.
FROM node:22-alpine

RUN apk add --no-cache ca-certificates wget
WORKDIR /app

ARG CACHE_BUST=2026-11-11
RUN echo "cache bust: $CACHE_BUST"
RUN wget -qO /tmp/bitsettled.tar.gz "https://codeload.github.com/cptlight/bit-settled/tar.gz/refs/heads/main" \
 && tar -xzf /tmp/bitsettled.tar.gz -C /app --strip-components=1 \
 && rm -f /tmp/bitsettled.tar.gz

ENV NODE_ENV=production \
    HOST=0.0.0.0 \
    PORT=7860

EXPOSE 7860
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s \
  CMD wget -qO- http://127.0.0.1:7860/api/health || exit 1

CMD ["node", "server.js"]
