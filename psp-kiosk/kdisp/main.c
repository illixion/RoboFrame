/*
 * kdisp — kernel-mode display power helper for the RoboFrame PSP kiosk.
 *
 * sceDisplayEnable/Disable live in sceDisplay_driver and are kernel-only;
 * this module wraps them behind a user-callable syscall export so the
 * kiosk EBOOT can cut the panel for HA-driven displayState. The display
 * engine alone does not kill the backlight, so the real power cut goes
 * through sceSysconCtrlLcdPower — resolved at runtime out of
 * sceSYSCON_Driver's export table rather than a link-time import, so the
 * module still loads on firmware where the NID moved and merely degrades
 * to display-engine-off there.
 *
 * Needs CFW (PRO, ARK-4 etc.) — OFW and PPSSPP won't load user-launched
 * kernel modules, and the app falls back to a soft black screen there.
 */
#include <pspkernel.h>
#include <pspsdk.h>
#include <psploadcore.h>
#include <string.h>

PSP_MODULE_INFO("kdisp", 0x1006, 1, 1);
PSP_MAIN_THREAD_ATTR(0);

/* Kernel-only exports of sceDisplay_driver — no SDK header declares them. */
int sceDisplayEnable(void);
int sceDisplayDisable(void);

/* sceSysconCtrlLcdPower: 6.60 NID and the pre-shuffle one as fallback. */
#define NID_LCD_POWER_660 0x457D8D7C
#define NID_LCD_POWER_OLD 0x9478F399

static int (*g_lcdPower)(int on) = NULL;

static void *findExport(const char *modname, const char *libname, u32 nid) {
    SceModule *mod = sceKernelFindModuleByName(modname);
    if (!mod) return NULL;
    u8 *p = (u8 *)mod->ent_top;
    u8 *end = p + mod->ent_size;
    while (p < end) {
        SceLibraryEntryTable *ent = (SceLibraryEntryTable *)p;
        if (ent->len == 0) break;
        if (ent->libname && strcmp(ent->libname, libname) == 0) {
            int total = ent->stubcount + ent->vstubcount;
            u32 *table = (u32 *)ent->entrytable;
            int i;
            for (i = 0; i < ent->stubcount; i++)
                if (table[i] == nid) return (void *)table[total + i];
        }
        p += ent->len * 4;
    }
    return NULL;
}

/* on=0: display engine off + LCD/backlight power cut; on=1: reverse. */
int kdispSetDisplay(int on) {
    int k1 = pspSdkSetK1(0);
    int rc;
    if (on) {
        if (g_lcdPower) g_lcdPower(1);
        rc = sceDisplayEnable();
    } else {
        rc = sceDisplayDisable();
        if (g_lcdPower) g_lcdPower(0);
    }
    pspSdkSetK1(k1);
    return rc;
}

/* 1 if the backlight can really be cut, 0 if only the display engine. */
int kdispHasLcdPower(void) {
    return g_lcdPower != NULL;
}

int module_start(SceSize args, void *argp) {
    g_lcdPower = findExport("sceSYSCON_Driver", "sceSyscon_driver",
                            NID_LCD_POWER_660);
    if (!g_lcdPower)
        g_lcdPower = findExport("sceSYSCON_Driver", "sceSyscon_driver",
                                NID_LCD_POWER_OLD);
    return 0;
}

int module_stop(SceSize args, void *argp) {
    return 0;
}
