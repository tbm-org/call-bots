# Ubuntu 24.04 with the exact browser revision required by package-lock.json.
FROM mcr.microsoft.com/playwright:v1.59.1-noble

USER root
RUN apt-get update && apt-get install -y --no-install-recommends xvfb xauth \
    && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --ignore-scripts --omit=dev --no-audit --no-fund
COPY src ./src
COPY media ./media
RUN mkdir -p /data && chown pwuser:pwuser /data

ENV CALL_BOTS_HOME=/data \
    CALL_BOTS_HOST=0.0.0.0 \
    CALL_BOTS_CONTAINER=1 \
    PLAYWRIGHT_BROWSERS_PATH=/ms-playwright
USER pwuser
EXPOSE 4610
CMD ["node", "src/cli.mjs", "ui", "--no-open"]
