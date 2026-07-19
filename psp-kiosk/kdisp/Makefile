TARGET = kdisp
OBJS = main.o

BUILD_PRX = 1
PRX_EXPORTS = exports.exp
USE_KERNEL_LIBS = 1

INCDIR =
CFLAGS = -O2 -G0 -Wall
LIBDIR =
LDFLAGS =
LIBS = -lpspdisplay_driver

PSPSDK = $(shell psp-config --pspsdk-path)
include $(PSPSDK)/lib/build.mak
