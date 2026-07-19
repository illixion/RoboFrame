/*
 * RoboFrame PSP kiosk — native slideshow client for imagemirror.
 *
 * Flow: connect WiFi (saved profile) → background thread polls
 * /random?json=1 for a post id (skipping videos), fetches the
 * server-resized JPEG via /get, decodes with libjpeg-turbo → main
 * thread crossfades between images at vsync and overlays an RTC
 * clock with intraFont. See README.md for config.txt keys.
 */
#include <pspkernel.h>
#include <pspdisplay.h>
#include <pspctrl.h>
#include <pspgu.h>
#include <psprtc.h>
#include <psppower.h>
#include <psputility.h>
#include <pspnet.h>
#include <pspnet_inet.h>
#include <pspnet_apctl.h>
#include <pspnet_resolver.h>

#include <arpa/inet.h>
#include <netinet/in.h>
#include <sys/socket.h>
#include <sys/select.h>
#include <unistd.h>
#include <errno.h>
#include <malloc.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

#include <turbojpeg.h>
#include <intraFont.h>

PSP_MODULE_INFO("RoboFramePSP", 0, 1, 0);
PSP_MAIN_THREAD_ATTR(THREAD_ATTR_USER | THREAD_ATTR_VFPU);
PSP_HEAP_SIZE_KB(-1024);

#define SCR_W 480
#define SCR_H 272
#define BUF_W 512          /* framebuffer + texture stride */
#define TEX_H 512          /* pow2 texture height */

/* ---------------------------------------------------------------- config */

static struct {
    char host[128];
    int  port;
    char token[128];
    char device_id[64];
    char extra_query[256];  /* appended verbatim to /random, e.g. "&q=rating%3Asafe" */
    int  dwell_sec;
    int  fade_ms;
    int  wifi_profile;
    int  clock_on;
    float clock_size;
    int  lowmem;
} cfg = {
    .host = "", .port = 3123, .token = "", .device_id = "psp-kiosk",
    .extra_query = "", .dwell_sec = 20, .fade_ms = 700,
    .wifi_profile = 1, .clock_on = 1, .clock_size = 1.4f, .lowmem = 1,
};

static void configLoad(void) {
    FILE *f = fopen("config.txt", "r");
    if (!f) return;
    char line[512];
    while (fgets(line, sizeof(line), f)) {
        char *nl = strpbrk(line, "\r\n");
        if (nl) *nl = 0;
        if (line[0] == '#' || line[0] == 0) continue;
        char *eq = strchr(line, '=');
        if (!eq) continue;
        *eq = 0;
        const char *k = line, *v = eq + 1;
        if      (!strcmp(k, "host"))         snprintf(cfg.host, sizeof(cfg.host), "%s", v);
        else if (!strcmp(k, "port"))         cfg.port = atoi(v);
        else if (!strcmp(k, "token"))        snprintf(cfg.token, sizeof(cfg.token), "%s", v);
        else if (!strcmp(k, "device_id"))    snprintf(cfg.device_id, sizeof(cfg.device_id), "%s", v);
        else if (!strcmp(k, "extra_query"))  snprintf(cfg.extra_query, sizeof(cfg.extra_query), "%s", v);
        else if (!strcmp(k, "dwell_sec"))    cfg.dwell_sec = atoi(v);
        else if (!strcmp(k, "fade_ms"))      cfg.fade_ms = atoi(v);
        else if (!strcmp(k, "wifi_profile")) cfg.wifi_profile = atoi(v);
        else if (!strcmp(k, "clock"))        cfg.clock_on = atoi(v);
        else if (!strcmp(k, "clock_size"))   cfg.clock_size = (float)atof(v);
        else if (!strcmp(k, "lowmem"))       cfg.lowmem = atoi(v);
    }
    fclose(f);
    if (cfg.dwell_sec < 3) cfg.dwell_sec = 3;
    if (cfg.fade_ms < 0) cfg.fade_ms = 0;
}

/* ------------------------------------------------------------ exit hooks */

static volatile int g_running = 1;

static int exitCallback(int arg1, int arg2, void *common) {
    g_running = 0;
    return 0;
}
static int callbackThread(SceSize args, void *argp) {
    int cbid = sceKernelCreateCallback("exit_cb", exitCallback, NULL);
    sceKernelRegisterExitCallback(cbid);
    sceKernelSleepThreadCB();
    return 0;
}
static void setupCallbacks(void) {
    int thid = sceKernelCreateThread("cb_thread", callbackThread,
                                     0x11, 0xFA0, 0, 0);
    if (thid >= 0) sceKernelStartThread(thid, 0, 0);
}

/* ----------------------------------------------------------------- state */

/* Shared between main (render) thread and the fetch thread. PSP is a
 * single-core machine with cooperative preemption, so volatile flags with
 * a single writer per field are sufficient — no atomics needed. */

typedef struct {
    unsigned int *pixels;   /* BUF_W * TEX_H RGBA, 16-byte aligned */
    int w, h;               /* valid image area */
} Slot;

static Slot g_slot[2];
static volatile int g_front = 0;          /* slot the main thread displays */
static volatile int g_incoming = 0;       /* fetch thread filled back slot */
static volatile int g_want_next = 1;      /* main asks fetch for an image */
static volatile int g_have_image = 0;     /* at least one image ever shown */
static char g_status[128] = "starting";   /* fetch thread → status line */
static volatile int g_status_is_error = 0;

static void setStatus(const char *msg, int is_error) {
    snprintf(g_status, sizeof(g_status), "%s", msg);
    g_status_is_error = is_error;
}

/* Case-insensitive header lookup (newlib hides strcasestr). */
static char *findHeader(char *haystack, const char *needle) {
    size_t nlen = strlen(needle);
    for (char *p = haystack; *p; p++)
        if (!strncasecmp(p, needle, nlen)) return p;
    return NULL;
}

/* ------------------------------------------------------------------- net */

static int netInitOnce(void) {
    int rc;
    /* libcglue also imports sceUtilityGetSystemParamInt, but only gets
     * linked after build.mak's SDK libs — referencing it here keeps all
     * sceUtility stubs in one cluster, or psp-fixup-imports rejects the
     * import table ("stubs out of order"). */
    int tz = 0;
    sceUtilityGetSystemParamInt(PSP_SYSTEMPARAM_ID_INT_TIMEZONE, &tz);
    if ((rc = sceUtilityLoadNetModule(PSP_NET_MODULE_COMMON)) < 0) return rc;
    if ((rc = sceUtilityLoadNetModule(PSP_NET_MODULE_INET)) < 0) return rc;
    if ((rc = sceNetInit(128 * 1024, 42, 4 * 1024, 42, 4 * 1024)) < 0) return rc;
    if ((rc = sceNetInetInit()) < 0) return rc;
    if ((rc = sceNetApctlInit(0x8000, 48)) < 0) return rc;
    return 0;
}

static int wifiConnect(void) {
    int rc = sceNetApctlConnect(cfg.wifi_profile);
    if (rc < 0) return rc;
    int last_state = -1;
    while (g_running) {
        int state = 0;
        if ((rc = sceNetApctlGetState(&state)) < 0) return rc;
        if (state != last_state) {
            char buf[64];
            snprintf(buf, sizeof(buf), "wifi: state %d/4", state);
            setStatus(buf, 0);
            last_state = state;
        }
        if (state == PSP_NET_APCTL_STATE_GOT_IP) return 0;
        sceKernelDelayThread(100 * 1000);
    }
    return -1;
}

/* Resolve host to an in_addr: dotted quad directly, else sceNetResolver. */
static int resolveHost(const char *host, struct in_addr *out) {
    if (inet_aton(host, out)) return 0;
    int rid = -1;
    char rbuf[1024];
    int rc = sceNetResolverCreate(&rid, rbuf, sizeof(rbuf));
    if (rc < 0) return rc;
    rc = sceNetResolverStartNtoA(rid, host, out, 5 * 1000 * 1000, 3);
    sceNetResolverDelete(rid);
    return rc;
}

/* recv/send that tolerate non-blocking sockets (PPSSPP's inet layer
 * returns EAGAIN instead of blocking): select() with a 15 s deadline,
 * retry on EAGAIN. Returns like recv(); -1 on timeout/error. */
static int recvWait(int s, void *buf, int len) {
    for (;;) {
        fd_set rf;
        FD_ZERO(&rf);
        FD_SET(s, &rf);
        struct timeval tv = { .tv_sec = 15, .tv_usec = 0 };
        int r = select(s + 1, &rf, NULL, NULL, &tv);
        if (r <= 0) return -1;
        int n = recv(s, buf, len, 0);
        if (n < 0 && (errno == EAGAIN || errno == EWOULDBLOCK)) continue;
        return n;
    }
}

static int sendAll(int s, const void *buf, int len) {
    const char *p = buf;
    int left = len;
    while (left > 0) {
        fd_set wf;
        FD_ZERO(&wf);
        FD_SET(s, &wf);
        struct timeval tv = { .tv_sec = 15, .tv_usec = 0 };
        if (select(s + 1, NULL, &wf, NULL, &tv) <= 0) return -1;
        int n = send(s, p, left, 0);
        if (n < 0 && (errno == EAGAIN || errno == EWOULDBLOCK)) continue;
        if (n <= 0) return -1;
        p += n;
        left -= n;
    }
    return len;
}

/* Blocking HTTP/1.1 GET over a fresh socket. Returns malloc'd body (caller
 * frees), fills status/ctype. -1 on transport error. Reads by Content-Length
 * (imagemirror always sets it for buffered responses); falls back to
 * read-to-close. */
static int httpGet(const char *path, unsigned char **body_out, int *len_out,
                   int *http_status, char *ctype, int ctype_len) {
    *body_out = NULL; *len_out = 0; *http_status = 0;
    if (ctype_len > 0) ctype[0] = 0;

    struct in_addr addr;
    if (resolveHost(cfg.host, &addr) < 0) { setStatus("dns lookup failed", 1); return -1; }

    int s = socket(AF_INET, SOCK_STREAM, 0);
    if (s < 0) { setStatus("socket() failed", 1); return -1; }

    /* PSP's sceNetInet takes SO_RCVTIMEO as a u32 in microseconds, not a
     * struct timeval — a timeval here reads as a ~15 microsecond timeout. */
    unsigned int timeout_us = 15 * 1000 * 1000;
    setsockopt(s, SOL_SOCKET, SO_RCVTIMEO, &timeout_us, sizeof(timeout_us));
    setsockopt(s, SOL_SOCKET, SO_SNDTIMEO, &timeout_us, sizeof(timeout_us));

    struct sockaddr_in sin;
    memset(&sin, 0, sizeof(sin));
    sin.sin_family = AF_INET;
    sin.sin_port = htons(cfg.port);
    sin.sin_addr = addr;
    if (connect(s, (struct sockaddr *)&sin, sizeof(sin)) < 0) {
        if (errno == EINPROGRESS || errno == EAGAIN || errno == EWOULDBLOCK) {
            fd_set wf;
            FD_ZERO(&wf);
            FD_SET(s, &wf);
            struct timeval tv = { .tv_sec = 15, .tv_usec = 0 };
            if (select(s + 1, NULL, &wf, NULL, &tv) <= 0) {
                close(s);
                setStatus("connect timeout", 1);
                return -1;
            }
        } else {
            close(s);
            setStatus("connect failed", 1);
            return -1;
        }
    }

    char req[1024];
    int rl = snprintf(req, sizeof(req),
                      "GET %s HTTP/1.1\r\nHost: %s:%d\r\n"
                      "User-Agent: RoboFramePSP/1.0\r\nConnection: close\r\n\r\n",
                      path, cfg.host, cfg.port);
    if (sendAll(s, req, rl) != rl) { close(s); setStatus("send failed", 1); return -1; }

    /* Read headers (up to 8 KB), keeping any body bytes that slid in. */
    char hdr[8192];
    int hlen = 0, body_start = -1;
    while (hlen < (int)sizeof(hdr) - 1) {
        int n = recvWait(s, hdr + hlen, sizeof(hdr) - 1 - hlen);
        if (n <= 0) break;
        hlen += n;
        hdr[hlen] = 0;
        char *sep = strstr(hdr, "\r\n\r\n");
        if (sep) { body_start = (int)(sep - hdr) + 4; break; }
    }
    if (body_start < 0) {
        char msg[64];
        snprintf(msg, sizeof(msg), "bad http response (errno %d)", errno);
        close(s);
        setStatus(msg, 1);
        return -1;
    }

    *http_status = atoi(hdr + 9); /* "HTTP/1.1 NNN" */

    int content_length = -1;
    char *p;
    if ((p = findHeader(hdr, "\r\ncontent-length:"))) content_length = atoi(p + 17);
    if ((p = findHeader(hdr, "\r\ncontent-type:")) && ctype_len > 0) {
        p += 15;
        while (*p == ' ') p++;
        int i = 0;
        while (p[i] && p[i] != '\r' && i < ctype_len - 1) { ctype[i] = p[i]; i++; }
        ctype[i] = 0;
    }

    int cap = content_length > 0 ? content_length : 256 * 1024;
    if (cap > 8 * 1024 * 1024) { close(s); setStatus("response too large", 1); return -1; }
    unsigned char *body = malloc(cap);
    if (!body) { close(s); setStatus("out of memory", 1); return -1; }

    int blen = hlen - body_start;
    if (blen > cap) blen = cap;
    memcpy(body, hdr + body_start, blen);

    while (content_length < 0 || blen < content_length) {
        if (blen == cap) {
            if (cap >= 8 * 1024 * 1024) break;
            cap *= 2;
            unsigned char *nb = realloc(body, cap);
            if (!nb) { free(body); close(s); setStatus("out of memory", 1); return -1; }
            body = nb;
        }
        int n = recvWait(s, body + blen, cap - blen);
        if (n <= 0) break;
        blen += n;
    }
    close(s);

    if (content_length > 0 && blen < content_length) {
        free(body);
        setStatus("truncated response", 1);
        return -1;
    }
    *body_out = body;
    *len_out = blen;
    return 0;
}

/* ---------------------------------------------------------------- fetcher */

static const char *VIDEO_EXTS[] = { "mp4", "webm", "mov", "mkv", "m4v", NULL };

static int extIsVideo(const char *ext) {
    for (int i = 0; VIDEO_EXTS[i]; i++)
        if (!strcasecmp(ext, VIDEO_EXTS[i])) return 1;
    return 0;
}

/* Pick a random non-video post id via /random?json=1. Returns id or -1. */
static long pickPostId(void) {
    for (int attempt = 0; attempt < 5 && g_running; attempt++) {
        char path[768];
        snprintf(path, sizeof(path),
                 "/random?json=1&token=%s&width=%d&height=%d%s",
                 cfg.token, SCR_W, SCR_H, cfg.extra_query);
        unsigned char *body; int blen, status;
        if (httpGet(path, &body, &blen, &status, NULL, 0) < 0) return -1;
        if (status != 200) {
            char msg[64];
            snprintf(msg, sizeof(msg), "server: HTTP %d on /random", status);
            setStatus(msg, 1);
            free(body);
            return -1;
        }
        /* {"id":123,"ext":"jpg"} */
        char json[256] = {0};
        memcpy(json, body, blen < 255 ? blen : 255);
        free(body);
        char *idp = strstr(json, "\"id\":");
        if (!idp) { setStatus("bad /random json", 1); return -1; }
        long id = atol(idp + 5);
        char ext[16] = {0};
        char *extp = strstr(json, "\"ext\":\"");
        if (extp) {
            extp += 7;
            int i = 0;
            while (*extp && *extp != '"' && i < 15) ext[i++] = *extp++;
        }
        if (extIsVideo(ext)) continue; /* redraw — videos are for real kiosks */
        return id;
    }
    setStatus("only videos came up, giving up", 1);
    return -1;
}

/* Fetch + decode one image into slot. Returns 0 on success. */
static int fetchImage(Slot *slot) {
    long id = pickPostId();
    if (id < 0) return -1;

    setStatus("downloading...", 0);
    char path[768];
    snprintf(path, sizeof(path),
             "/get?id=%ld&token=%s&width=%d&height=%d&lowmem=%d&deviceId=%s",
             id, cfg.token, SCR_W, SCR_H, cfg.lowmem, cfg.device_id);
    unsigned char *body; int blen, status;
    char ctype[64];
    if (httpGet(path, &body, &blen, &status, ctype, sizeof(ctype)) < 0) return -1;
    if (status != 200) {
        char msg[64];
        snprintf(msg, sizeof(msg), "server: HTTP %d on /get", status);
        setStatus(msg, 1);
        free(body);
        return -1;
    }
    if (strncasecmp(ctype, "image/jpeg", 10) != 0) {
        char msg[96];
        snprintf(msg, sizeof(msg), "skipping non-jpeg: %s", ctype);
        setStatus(msg, 1);
        free(body);
        return -1;
    }

    tjhandle tj = tjInitDecompress();
    if (!tj) { free(body); setStatus("tj init failed", 1); return -1; }
    int w = 0, h = 0, subsamp = 0, colorspace = 0;
    if (tjDecompressHeader3(tj, body, blen, &w, &h, &subsamp, &colorspace) < 0 ||
        w <= 0 || h <= 0 || w > BUF_W || h > TEX_H) {
        tjDestroy(tj);
        free(body);
        setStatus("jpeg header rejected", 1);
        return -1;
    }
    memset(slot->pixels, 0, BUF_W * TEX_H * 4);
    int rc = tjDecompress2(tj, body, blen, (unsigned char *)slot->pixels,
                           w, BUF_W * 4, h, TJPF_RGBA, TJFLAG_FASTDCT);
    tjDestroy(tj);
    free(body);
    if (rc < 0) { setStatus("jpeg decode failed", 1); return -1; }

    /* Blending is on for crossfades, so an undefined alpha byte from the
     * decoder would render the image invisible — force it opaque. */
    for (int y = 0; y < h; y++) {
        unsigned int *row = slot->pixels + y * BUF_W;
        for (int x = 0; x < w; x++) row[x] |= 0xFF000000;
    }

    /* Textures are read by the GE, not the CPU — flush cached writes. */
    sceKernelDcacheWritebackRange(slot->pixels, BUF_W * TEX_H * 4);
    slot->w = w;
    slot->h = h;
    setStatus("", 0);
    return 0;
}

static int fetchThread(SceSize args, void *argp) {
    setStatus("loading net modules", 0);
    int rc = netInitOnce();
    if (rc < 0) { setStatus("net init failed", 1); return 0; }

    setStatus("connecting to wifi", 0);
    if (wifiConnect() < 0) { setStatus("wifi connect failed", 1); return 0; }

    union SceNetApctlInfo info;
    if (sceNetApctlGetInfo(PSP_NET_APCTL_INFO_IP, &info) == 0) {
        char msg[64];
        snprintf(msg, sizeof(msg), "connected: %s", info.ip);
        setStatus(msg, 0);
    }

    while (g_running) {
        if (!g_want_next || g_incoming) {
            sceKernelDelayThread(50 * 1000);
            continue;
        }
        int back = g_front ^ 1;
        if (fetchImage(&g_slot[back]) == 0) {
            g_want_next = 0;
            g_incoming = 1;
        } else {
            sceKernelDelayThread(5 * 1000 * 1000); /* error → retry in 5 s */
        }
    }
    return 0;
}

/* -------------------------------------------------------------- rendering */

static unsigned int __attribute__((aligned(16))) g_list[256 * 1024 / 4];

/* Through-mode sprite vertex, same layout as the SDK blit sample:
 * 16-bit texel UVs + 16-bit screen coords, color at a 4-byte offset. */
typedef struct {
    short u, v;
    unsigned int color;
    short x, y, z;
} Vertex;

#define VFMT (GU_TEXTURE_16BIT | GU_COLOR_8888 | GU_VERTEX_16BIT | GU_TRANSFORM_2D)

static void guInit(void) {
    sceGuInit();
    sceGuStart(GU_DIRECT, g_list);
    sceGuDrawBuffer(GU_PSM_8888, (void *)0, BUF_W);
    sceGuDispBuffer(SCR_W, SCR_H, (void *)(BUF_W * SCR_H * 4), BUF_W);
    sceGuDepthBuffer((void *)(BUF_W * SCR_H * 4 * 2), BUF_W);
    sceGuOffset(2048 - SCR_W / 2, 2048 - SCR_H / 2);
    sceGuViewport(2048, 2048, SCR_W, SCR_H);
    sceGuDepthRange(65535, 0);
    sceGuScissor(0, 0, SCR_W, SCR_H);
    sceGuEnable(GU_SCISSOR_TEST);
    sceGuDisable(GU_DEPTH_TEST);
    sceGuDepthMask(GU_TRUE);
    sceGuShadeModel(GU_SMOOTH);
    sceGuFrontFace(GU_CW);
    sceGuDisable(GU_CULL_FACE);
    sceGuEnable(GU_TEXTURE_2D);
    sceGuEnable(GU_BLEND);
    sceGuBlendFunc(GU_ADD, GU_SRC_ALPHA, GU_ONE_MINUS_SRC_ALPHA, 0, 0);
    sceGuClearColor(0xFF000000);
    sceGuClearDepth(0);
    sceGuFinish();
    sceGuSync(0, 0);
    sceDisplayWaitVblankStart();
    sceGuDisplay(GU_TRUE);
}

/* Draw a slot's image centered, tinted with `alpha` (0..255). Split into
 * 32 px vertical strips — the GE's texture cache renders wide quads slowly. */
static void drawSlot(const Slot *s, int alpha) {
    if (!s->w || !s->h || alpha <= 0) return;
    int x0 = (SCR_W - s->w) / 2;
    int y0 = (SCR_H - s->h) / 2;
    unsigned int color = ((unsigned int)alpha << 24) | 0x00FFFFFF;

    sceGuEnable(GU_TEXTURE_2D);
    sceGuTexMode(GU_PSM_8888, 0, 0, 0);
    sceGuTexImage(0, BUF_W, TEX_H, BUF_W, s->pixels);
    sceGuTexFunc(GU_TFX_MODULATE, GU_TCC_RGBA);
    sceGuTexFilter(GU_LINEAR, GU_LINEAR);
    sceGuTexWrap(GU_CLAMP, GU_CLAMP);
    sceGuTexScale(1.0f, 1.0f);   /* intraFont leaves its own scale behind */
    sceGuTexOffset(0.0f, 0.0f);
    sceGuTexFlush();             /* GE texture cache won't see new texels otherwise */

    const int STRIP = 32;
    int nstrips = (s->w + STRIP - 1) / STRIP;
    Vertex *v = sceGuGetMemory(nstrips * 2 * sizeof(Vertex));
    int i = 0;
    for (int sx = 0; sx < s->w; sx += STRIP) {
        int sw = s->w - sx < STRIP ? s->w - sx : STRIP;
        v[i].u = sx;          v[i].v = 0;
        v[i].color = color;
        v[i].x = x0 + sx;     v[i].y = y0;        v[i].z = 0;
        i++;
        v[i].u = sx + sw;     v[i].v = s->h;
        v[i].color = color;
        v[i].x = x0 + sx + sw; v[i].y = y0 + s->h; v[i].z = 0;
        i++;
    }
    sceKernelDcacheWritebackRange(v, i * sizeof(Vertex));
    sceGuDrawArray(GU_SPRITES, VFMT, i, 0, v);
}


/* ------------------------------------------------------------------- main */

int main(void) {
    setupCallbacks();
    configLoad();
    scePowerSetClockFrequency(222, 222, 111); /* photo frame: run cool */

    for (int i = 0; i < 2; i++) {
        g_slot[i].pixels = memalign(16, BUF_W * TEX_H * 4);
        if (!g_slot[i].pixels) sceKernelExitGame();
        memset(g_slot[i].pixels, 0, BUF_W * TEX_H * 4);
        g_slot[i].w = g_slot[i].h = 0;
    }

    guInit();
    intraFontInit();
    intraFont *font = intraFontLoad("flash0:/font/ltn0.pgf", 0);
    /* PPSSPP's VFS rejects intraFont's open flags on flash0 — fall back to
     * a copy shipped next to the EBOOT (real hardware always has flash0). */
    if (!font) font = intraFontLoad("ltn0.pgf", 0);

    sceCtrlSetSamplingCycle(0);
    sceCtrlSetSamplingMode(PSP_CTRL_MODE_ANALOG);

    if (!cfg.host[0]) {
        setStatus("config.txt missing host= — see README", 1);
    } else {
        SceUID thid = sceKernelCreateThread("fetch", fetchThread, 0x25,
                                            0x40000, PSP_THREAD_ATTR_USER, 0);
        if (thid >= 0) sceKernelStartThread(thid, 0, 0);
        else setStatus("fetch thread failed", 1);
    }

    u64 dwell_start = 0, tick_freq = sceRtcGetTickResolution();
    sceRtcGetCurrentTick(&dwell_start);
    int fade_frames = cfg.fade_ms / 17;  /* ~60 Hz */
    if (fade_frames < 1) fade_frames = 1;
    int fade_step = -1;                  /* -1 idle, else 0..fade_frames */
    int paused = 0;
    unsigned int prev_buttons = 0;
    int power_tick = 0;

    while (g_running) {
        /* --- input --- */
        SceCtrlData pad;
        sceCtrlPeekBufferPositive(&pad, 1);
        unsigned int pressed = pad.Buttons & ~prev_buttons;
        prev_buttons = pad.Buttons;
        if (pressed & (PSP_CTRL_CROSS | PSP_CTRL_RIGHT)) g_want_next = 1;
        if (pressed & PSP_CTRL_START) paused = !paused;
        if (pressed & PSP_CTRL_SELECT) cfg.clock_on = !cfg.clock_on;

        /* --- dwell timer --- */
        u64 now;
        sceRtcGetCurrentTick(&now);
        if (!paused && g_have_image &&
            (now - dwell_start) / tick_freq >= (u64)cfg.dwell_sec)
            g_want_next = 1;

        /* --- take incoming image, start crossfade --- */
        if (g_incoming && fade_step < 0) {
            fade_step = g_have_image ? 0 : fade_frames; /* first image: cut */
        }

        if (!(power_tick++ % 300)) scePowerTick(PSP_POWER_TICK_DISPLAY);

        /* --- draw --- */
        sceGuStart(GU_DIRECT, g_list);
        /* intraFontPrint force-enables the depth test on exit; our depth
         * buffer is never cleared, so anything drawn with it on is culled. */
        sceGuDisable(GU_DEPTH_TEST);
        sceGuClearColor(0xFF000000);
        sceGuClear(GU_COLOR_BUFFER_BIT);

        if (fade_step >= 0) {
            int a = fade_step * 255 / fade_frames;
            drawSlot(&g_slot[g_front], 255);
            drawSlot(&g_slot[g_front ^ 1], a);
            if (fade_step++ >= fade_frames) {
                g_front ^= 1;
                g_incoming = 0;
                g_have_image = 1;
                fade_step = -1;
                sceRtcGetCurrentTick(&dwell_start);
            }
        } else {
            drawSlot(&g_slot[g_front], 255);
        }

        if (font) {
            intraFontActivate(font);
            if (cfg.clock_on) {
                ScePspDateTime t;
                sceRtcGetCurrentClockLocalTime(&t);
                char clk[8];
                snprintf(clk, sizeof(clk), "%02d:%02d", t.hour, t.minute);
                intraFontSetStyle(font, cfg.clock_size, 0xDDFFFFFF, 0xFF000000,
                                  0.0f, INTRAFONT_ALIGN_RIGHT);
                intraFontPrint(font, SCR_W - 8, SCR_H - 10, clk);
            }
            if (g_status[0]) {
                intraFontSetStyle(font, 0.8f,
                                  g_status_is_error ? 0xFF5555FF : 0xFFFFFFFF,
                                  0xFF000000, 0.0f, INTRAFONT_ALIGN_LEFT);
                intraFontPrint(font, 8, 18, g_status);
                if (paused) intraFontPrint(font, 8, 34, "paused");
            } else if (paused) {
                intraFontSetStyle(font, 0.8f, 0xFFFFFFFF, 0xFF000000,
                                  0.0f, INTRAFONT_ALIGN_LEFT);
                intraFontPrint(font, 8, 18, "paused");
            }
        }

        sceGuFinish();
        sceGuSync(0, 0);
        sceDisplayWaitVblankStart();
        sceGuSwapBuffers();
    }

    if (font) intraFontUnload(font);
    intraFontShutdown();
    sceGuTerm();
    sceKernelExitGame();
    return 0;
}
