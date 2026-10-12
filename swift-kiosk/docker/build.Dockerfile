# The aarch64 build environment: the Swift toolchain plus the headers the
# renderer links against. The binary is built here and run on Debian 13
# (the Pi), so every library below is one Debian 13 ships under the same
# soname; noble's older glibc keeps the binary loadable there.
FROM swift:6.2.4-noble
RUN apt-get update && DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends \
      libsdl2-dev libsdl2-ttf-dev libsdl2-image-dev libmpv-dev libgles-dev libegl-dev \
    && rm -rf /var/lib/apt/lists/*
