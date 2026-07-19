TARGET = pspkiosk
OBJS = main.o ws.o kdisp_stub.o

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

EXTRA_TARGETS = EBOOT.PBP kdisp.prx
PSP_EBOOT_TITLE = RoboFrame PSP Kiosk

PSPSDK = $(shell psp-config --pspsdk-path)
include $(PSPSDK)/lib/build.mak

# Kernel display-power helper, shipped next to the EBOOT. kdisp_stub.S is
# the checked-in user-side stub (regenerate with `psp-build-exports -s
# kdisp/exports.exp` if the export list changes). Declared after build.mak
# so it can't shadow the default `all` target.
kdisp.prx: kdisp/main.c kdisp/exports.exp
	$(MAKE) -C kdisp
	cp kdisp/kdisp.prx $@
