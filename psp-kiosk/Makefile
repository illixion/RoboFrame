TARGET = pspkiosk
OBJS = main.o

INCDIR =
CFLAGS = -O2 -G0 -Wall
CXXFLAGS = $(CFLAGS) -fno-exceptions -fno-rtti
ASFLAGS = $(CFLAGS)

LIBDIR =
LDFLAGS =
# build.mak appends -lpspdebug -lpspdisplay -lpspge -lpspctrl -lpspnet
# -lpspnet_apctl after this list; repeating them here breaks stub ordering.
LIBS = -lintrafont -lturbojpeg -lgif -lpspgu -lpspgum -lpsprtc -lpsppower \
       -lpsputility -lm

EXTRA_TARGETS = EBOOT.PBP
PSP_EBOOT_TITLE = RoboFrame PSP Kiosk

PSPSDK = $(shell psp-config --pspsdk-path)
include $(PSPSDK)/lib/build.mak
