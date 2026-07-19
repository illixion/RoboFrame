/*
 * kdisp — kernel-mode display power helper for the RoboFrame PSP kiosk.
 *
 * sceDisplayEnable/Disable live in sceDisplay_driver and are kernel-only;
 * this module wraps them behind a user-callable syscall export so the
 * kiosk EBOOT can cut the panel+backlight for HA-driven displayState.
 * Needs CFW (ARK-4 etc.) — OFW and PPSSPP won't load user-launched
 * kernel modules, and the app falls back to a soft black screen there.
 */
#include <pspkernel.h>
#include <pspsdk.h>

PSP_MODULE_INFO("kdisp", 0x1006, 1, 0);
PSP_MAIN_THREAD_ATTR(0);

/* Kernel-only exports of sceDisplay_driver — no SDK header declares them. */
int sceDisplayEnable(void);
int sceDisplayDisable(void);

int kdispSetDisplay(int on) {
    int k1 = pspSdkSetK1(0);
    int rc = on ? sceDisplayEnable() : sceDisplayDisable();
    pspSdkSetK1(k1);
    return rc;
}

int module_start(SceSize args, void *argp) {
    return 0;
}

int module_stop(SceSize args, void *argp) {
    return 0;
}
