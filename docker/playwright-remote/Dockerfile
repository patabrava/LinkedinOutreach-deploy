FROM mcr.microsoft.com/playwright:v1.57.0-noble

ENV DEBIAN_FRONTEND=noninteractive \
    DISPLAY=:99 \
    CHROME_USER_DATA_DIR=/data/scraper/interactive-profile \
    LINKEDIN_LOGIN_URL=https://www.linkedin.com/login \
    PLAYWRIGHT_BROWSERS_PATH=/ms-playwright

RUN apt-get update \
    && apt-get install -y --no-install-recommends \
      fluxbox \
      novnc \
      supervisor \
      websockify \
      x11vnc \
      xvfb \
    && rm -rf /var/lib/apt/lists/*

# The published multi-architecture image has not always exposed the same
# browser payload on every platform. Pin the required revision and turn browser
# discovery into a build-time contract instead of a runtime failure.
RUN npx --yes playwright@1.57.0 install chromium \
    && chromium_bin="$(find /ms-playwright -type f \
      \( -path '*/chrome-linux/chrome' -o -path '*/chrome-linux64/chrome' \) \
      -perm -111 | sort | head -n 1)" \
    && test -n "$chromium_bin" \
    && ln -s "$chromium_bin" /usr/local/bin/chromium-runtime

COPY docker/playwright-remote/supervisord.conf /etc/supervisor/conf.d/supervisord.conf
COPY docker/playwright-remote/start-chromium.sh /usr/local/bin/start-chromium.sh
RUN chmod +x /usr/local/bin/start-chromium.sh

CMD ["/usr/bin/supervisord", "-c", "/etc/supervisor/conf.d/supervisord.conf"]
