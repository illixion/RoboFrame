# A Pi-like runtime for trying the kiosk without the Pi: Debian 13 with the
# same libraries the Pi has, Mesa's software GLES2 and a virtual X server.
FROM debian:trixie-slim
RUN apt-get update && DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends \
      libsdl2-2.0-0 libsdl2-ttf-2.0-0 libsdl2-image-2.0-0 libmpv2 libgles2 libegl1 \
      libegl-mesa0 libgl1-mesa-dri libcurl4t64 ca-certificates \
      fonts-dejavu-core fonts-noto-color-emoji xvfb x11-apps imagemagick \
    && rm -rf /var/lib/apt/lists/*
