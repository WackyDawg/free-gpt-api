FROM ghcr.io/puppeteer/puppeteer:22.9.0

ENV DISPLAY=:99
ENV NO_AT_BRIDGE=1
ENV LIBGL_ALWAYS_SOFTWARE=1
ENV GALLIUM_DRIVER=llvmpipe
ENV PUPPETEER_SKIP_CHROMIUM_DOWNLOAD=true
ENV PUPPETEER_EXECUTABLE_PATH=/usr/bin/google-chrome-stable

USER root

RUN apt-get update && apt-get install -y --no-install-recommends ca-certificates curl \
    && curl -fsSL https://deb.nodesource.com/setup_22.x | bash - \
    && apt-get install -y nodejs \
    && rm -rf /var/lib/apt/lists/*

RUN apt-get update && apt-get install -y --no-install-recommends \
    xvfb \
    wget \
    libxdo3 \
    libva-drm2 \
    libva-x11-2 \
    libvdpau1 \
    libgstreamer-plugins-base1.0-0 \
    gstreamer1.0-pipewire \
    libxcb-xfixes0 \
    libxcb-shape0 \
    libxkbcommon0 \
    libgl1-mesa-glx \
    libgbm1 \
    at-spi2-core \
    && rm -rf /var/lib/apt/lists/*

USER pptruser
WORKDIR /usr/src/app

COPY --chown=pptruser:pptruser package*.json ./

RUN npm install --omit=dev

COPY --chown=pptruser:pptruser . .

COPY --chown=pptruser:pptruser docker-entrypoint.sh ./
RUN chmod +x docker-entrypoint.sh

EXPOSE 3000

CMD ["./docker-entrypoint.sh"]