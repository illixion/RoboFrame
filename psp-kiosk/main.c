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
#include <gif_lib.h>
#include <intraFont.h>

#include "ws.h"

/* kdisp.prx syscall export (weak import — only call when g_hw_display). */
int kdispSetDisplay(int on);

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
    unsigned int *pixels;   /* BUF_W * TEX_H RGBA, 16-byte aligned — the
                             * texture the GE samples (current frame) */
    int w, h;               /* valid image area */
    long id;                /* imagemirror post id */
    /* Animated GIFs: packed w*h RGBA frames + per-frame delays. Static
     * images leave anim NULL / nframes 1. */
    unsigned char *anim;
    unsigned int *delays_ms;
    int nframes, frame;
    u64 next_frame_tick;
} Slot;

/* Cap on decoded animation storage per slot. Two slots can be live at
 * once and the PSP-1000 only has ~24 MB of user RAM. */
#define MAX_ANIM_BYTES (6 * 1024 * 1024)

static void slotFreeAnim(Slot *s) {
    free(s->anim);
    free(s->delays_ms);
    s->anim = NULL;
    s->delays_ms = NULL;
    s->nframes = 1;
    s->frame = 0;
}

/* Copy packed frame n into the slot's strided texture and flush it out of
 * the dcache so the GE sees it. */
static void slotShowFrame(Slot *s, int n) {
    if (!s->anim || n >= s->nframes) return;
    const unsigned char *src = s->anim + (size_t)n * s->w * s->h * 4;
    for (int y = 0; y < s->h; y++)
        memcpy(s->pixels + y * BUF_W, src + (size_t)y * s->w * 4, s->w * 4);
    sceKernelDcacheWritebackRange(s->pixels, BUF_W * s->h * 4);
    s->frame = n;
}

static Slot g_slot[2];
static volatile int g_front = 0;          /* slot the main thread displays */
static volatile int g_incoming = 0;       /* fetch thread filled back slot */
static volatile int g_incoming_replay = 0; /* incoming is a history replay */
static volatile int g_want_next = 1;      /* main asks fetch for an image */
static volatile int g_have_image = 0;     /* at least one image ever shown */
static char g_status[128] = "starting";   /* fetch thread → status line */
static volatile int g_status_is_error = 0;
static volatile u64 g_status_until = 0;   /* 0 = sticky, else expiry tick */

static void setStatus(const char *msg, int is_error) {
    snprintf(g_status, sizeof(g_status), "%s", msg);
    g_status_is_error = is_error;
    g_status_until = 0;
}

/* Transient toast: clears itself after ms (render loop enforces). */
static void setToast(const char *msg, int is_error, int ms) {
    u64 now, freq = sceRtcGetTickResolution();
    sceRtcGetCurrentTick(&now);
    snprintf(g_status, sizeof(g_status), "%s", msg);
    g_status_is_error = is_error;
    g_status_until = now + (u64)ms * (freq / 1000);
}

/* --- navigation / remote-action mailboxes (main → fetch thread) --- */

static volatile long g_req_id = -1;       /* -1 = pick random, else replay */
static volatile int g_req_replay = 0;     /* don't append to history */

#define ACT_NONE  0
#define ACT_SAVE  1
#define ACT_BLOCK 2
#define ACT_LISTS 3
static volatile int g_action = ACT_NONE;
static volatile long g_action_id = 0;

/* Ring of recently shown post ids for LEFT/RIGHT navigation. */
#define HIST_MAX 64
static long g_hist[HIST_MAX];
static int g_hist_len = 0, g_hist_pos = -1;

static void histAppend(long id) {
    if (g_hist_len == HIST_MAX) {
        memmove(g_hist, g_hist + 1, (HIST_MAX - 1) * sizeof(long));
        g_hist_len--;
    }
    g_hist[g_hist_len++] = id;
    g_hist_pos = g_hist_len - 1;
}

static void histPurge(long id) {
    int w = 0;
    for (int i = 0; i < g_hist_len; i++)
        if (g_hist[i] != id) g_hist[w++] = g_hist[i];
    if (g_hist_pos >= w) g_hist_pos = w - 1;
    g_hist_len = w;
}

/* --- tag-list picker state --- */

#define LISTS_MAX 32
static volatile int g_lists_count = -1;   /* -1 = not fetched yet */
static char g_list_preview[LISTS_MAX][48];
static volatile int g_active_list = -1;   /* -1 = server default */

/* --- WebSocket session state --- */

#define SESSION_ID "main"
static volatile int g_ws_up = 0;          /* connected + configured */
static volatile int g_ws_denied = 0;      /* 1008 close: bad token */
static volatile int g_we_are_driver = 0;  /* displaySync mergeDriver == us */
static volatile long g_last_ready_id = 0; /* imageReady dedup */
static volatile int g_display_on = 1;
static int g_hw_display = 0;              /* kdisp.prx loaded */
static volatile int g_net_ready = 0;      /* apctl got an IP */

/* Outgoing WS messages from other threads (main) — the ws thread owns
 * the socket and drains this. Single producer / single consumer. */
#define OUTQ_N 8
static char g_outq[OUTQ_N][192];
static volatile int g_outq_w = 0, g_outq_r = 0;

static void wsEnqueue(const char *msg) {
    int next = (g_outq_w + 1) % OUTQ_N;
    if (next == g_outq_r) return; /* full — drop, requests are re-sendable */
    snprintf(g_outq[g_outq_w], sizeof(g_outq[0]), "%s", msg);
    g_outq_w = next;
}

/* --- naive JSON field extraction (flat, first occurrence after `from`) --- */

static const char *jsonFind(const char *json, const char *key) {
    char pat[48];
    snprintf(pat, sizeof(pat), "\"%s\":", key);
    return strstr(json, pat) ? strstr(json, pat) + strlen(pat) : NULL;
}

static long jsonLong(const char *json, const char *key, long def) {
    const char *p = jsonFind(json, key);
    if (!p) return def;
    while (*p == ' ') p++;
    if (*p == '-' || (*p >= '0' && *p <= '9')) return atol(p);
    return def;
}

static int jsonStr(const char *json, const char *key, char *out, int outlen) {
    const char *p = jsonFind(json, key);
    if (!p) return -1;
    while (*p == ' ') p++;
    if (*p != '"') return -1;
    p++;
    int i = 0;
    while (*p && *p != '"' && i < outlen - 1) out[i++] = *p++;
    out[i] = 0;
    return 0;
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
        char list_q[24] = "";
        if (g_active_list >= 0)
            snprintf(list_q, sizeof(list_q), "&list=%d", g_active_list);
        char path[768];
        snprintf(path, sizeof(path),
                 "/random?json=1&token=%s&width=%d&height=%d%s%s",
                 cfg.token, SCR_W, SCR_H, list_q, cfg.extra_query);
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

/* ------------------------------------------------------------ gif decode */

typedef struct { const unsigned char *buf; int len, pos; } GifMem;

static int gifMemRead(GifFileType *g, GifByteType *out, int n) {
    GifMem *m = g->UserData;
    if (n > m->len - m->pos) n = m->len - m->pos;
    memcpy(out, m->buf + m->pos, n);
    m->pos += n;
    return n;
}

/* Composite one GIF raster onto the RGBA canvas, honoring per-frame
 * palette, offset, transparency and interlacing. */
static void gifBlitFrame(unsigned int *canvas, int cw, int ch,
                         GifFileType *gif, SavedImage *img, int transparent) {
    GifImageDesc *d = &img->ImageDesc;
    ColorMapObject *cmap = d->ColorMap ? d->ColorMap : gif->SColorMap;
    if (!cmap) return;
    static const int ipass_start[] = { 0, 4, 2, 1 };
    static const int ipass_step[]  = { 8, 8, 4, 2 };
    int row = 0;
    for (int pass = 0; pass < (d->Interlace ? 4 : 1); pass++) {
        int ystart = d->Interlace ? ipass_start[pass] : 0;
        int ystep  = d->Interlace ? ipass_step[pass] : 1;
        for (int y = ystart; y < d->Height; y += ystep, row++) {
            int cy = d->Top + y;
            if (cy < 0 || cy >= ch) continue;
            const GifByteType *src = img->RasterBits + (size_t)row * d->Width;
            unsigned int *dst = canvas + (size_t)cy * cw;
            for (int x = 0; x < d->Width; x++) {
                int cx = d->Left + x;
                int ci = src[x];
                if (cx < 0 || cx >= cw || ci == transparent ||
                    ci >= cmap->ColorCount)
                    continue;
                GifColorType c = cmap->Colors[ci];
                dst[cx] = 0xFF000000u | ((unsigned int)c.Blue << 16) |
                          ((unsigned int)c.Green << 8) | c.Red;
            }
        }
        if (!d->Interlace) break;
    }
}

/* Decode an animated GIF into slot->anim (packed RGBA frames) and stage
 * frame 0. Frames beyond MAX_ANIM_BYTES are dropped. Returns 0 on success. */
static int decodeGif(Slot *slot, const unsigned char *buf, int len) {
    GifMem mem = { buf, len, 0 };
    int gerr = 0;
    GifFileType *gif = DGifOpen(&mem, gifMemRead, &gerr);
    if (!gif) { setStatus("gif open failed", 1); return -1; }
    if (DGifSlurp(gif) != GIF_OK || gif->ImageCount < 1) {
        DGifCloseFile(gif, &gerr);
        setStatus("gif decode failed", 1);
        return -1;
    }
    int w = gif->SWidth, h = gif->SHeight;
    if (w <= 0 || h <= 0 || w > BUF_W || h > TEX_H) {
        DGifCloseFile(gif, &gerr);
        setStatus("gif too large", 1);
        return -1;
    }

    size_t frame_bytes = (size_t)w * h * 4;
    int max_frames = (int)(MAX_ANIM_BYTES / frame_bytes);
    int nframes = gif->ImageCount < max_frames ? gif->ImageCount : max_frames;
    if (nframes < 1) nframes = 1;

    slotFreeAnim(slot);
    unsigned char *anim = malloc((size_t)nframes * frame_bytes);
    unsigned int *delays = malloc(nframes * sizeof(unsigned int));
    unsigned int *canvas = malloc(frame_bytes);
    if (!anim || !delays || !canvas) {
        free(anim); free(delays); free(canvas);
        DGifCloseFile(gif, &gerr);
        setStatus("gif: out of memory", 1);
        return -1;
    }
    /* Opaque black canvas: we composite over black anyway, and it keeps
     * every texel opaque for the crossfade blend. */
    for (size_t i = 0; i < frame_bytes / 4; i++) canvas[i] = 0xFF000000u;

    for (int i = 0; i < nframes; i++) {
        GraphicsControlBlock gcb = { .DelayTime = 10, .TransparentColor = -1,
                                     .DisposalMode = DISPOSAL_UNSPECIFIED };
        DGifSavedExtensionToGCB(gif, i, &gcb);
        gifBlitFrame(canvas, w, h, gif, &gif->SavedImages[i], gcb.TransparentColor);
        memcpy(anim + (size_t)i * frame_bytes, canvas, frame_bytes);
        unsigned int ms = (unsigned int)gcb.DelayTime * 10;
        delays[i] = ms < 20 ? 100 : ms;
        /* Post-frame disposal. PREVIOUS is approximated as BACKGROUND —
         * black — rather than keeping a second canvas copy around. */
        if (gcb.DisposalMode == DISPOSE_BACKGROUND ||
            gcb.DisposalMode == DISPOSE_PREVIOUS) {
            GifImageDesc *d = &gif->SavedImages[i].ImageDesc;
            for (int y = d->Top; y < d->Top + d->Height && y < h; y++)
                for (int x = d->Left; x < d->Left + d->Width && x < w; x++)
                    if (y >= 0 && x >= 0) canvas[(size_t)y * w + x] = 0xFF000000u;
        }
    }
    free(canvas);
    DGifCloseFile(gif, &gerr);

    slot->anim = anim;
    slot->delays_ms = delays;
    slot->nframes = nframes;
    slot->w = w;
    slot->h = h;
    memset(slot->pixels, 0, BUF_W * TEX_H * 4);
    slotShowFrame(slot, 0);
    return 0;
}

/* Fetch + decode one image into slot. Returns 0 on success, -1 on a
 * transport/server error (worth backing off), -2 on unsupported content
 * (re-pick another post immediately). */
static int fetchImage(Slot *slot, long want_id, int replay) {
    long id = want_id >= 0 ? want_id : pickPostId();
    if (id < 0) return -1;

    /* History replays skip the server-side /history record so browsing
     * back doesn't spam duplicate entries. */
    char path[768];
    snprintf(path, sizeof(path),
             "/get?id=%ld&token=%s&width=%d&height=%d&lowmem=%d&deviceId=%s%s",
             id, cfg.token, SCR_W, SCR_H, cfg.lowmem, cfg.device_id,
             replay ? "&record=0" : "");
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
    if (strncasecmp(ctype, "image/gif", 9) == 0) {
        int rc = decodeGif(slot, body, blen);
        free(body);
        if (rc == 0) { slot->id = id; setStatus("", 0); }
        return rc;
    }
    if (strncasecmp(ctype, "image/jpeg", 10) != 0) {
        /* e.g. animated WebP from a server without the GIF lowmem variant —
         * not an error worth stalling on, just draw a different post */
        free(body);
        return -2;
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
    slotFreeAnim(slot);
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
    slot->id = id;
    setStatus("", 0);
    return 0;
}

/* Build per-list previews from [["tag","tag"],...] — works on the bare
 * /rpc/tags.json body and on a whole {"action":"tagLists",...} WS frame
 * (strings outside the nested arrays sit at depth 0 and are ignored). */
static void parseTagLists(const unsigned char *body, int blen) {
    int depth = 0, list = -1, in_str = 0, esc = 0, plen = 0;
    for (int i = 0; i < blen; i++) {
        char c = body[i];
        if (in_str) {
            if (esc) { esc = 0; continue; }
            if (c == '\\') { esc = 1; continue; }
            if (c == '"') { in_str = 0; continue; }
            if (list >= 0 && list < LISTS_MAX && plen < 44)
                g_list_preview[list][plen++] = c;
            continue;
        }
        if (c == '"') {
            in_str = 1;
            /* separate tags in the preview with a space */
            if (list >= 0 && list < LISTS_MAX && plen > 0 && plen < 44)
                g_list_preview[list][plen++] = ' ';
        } else if (c == '[') {
            if (++depth == 2) {
                list++;
                plen = 0;
                if (list < LISTS_MAX) g_list_preview[list][0] = 0;
            }
        } else if (c == ']') {
            if (depth-- == 2 && list >= 0 && list < LISTS_MAX)
                g_list_preview[list][plen] = 0;
        }
    }
    g_lists_count = list + 1 > LISTS_MAX ? LISTS_MAX : list + 1;
}

static void fetchTagLists(void) {
    unsigned char *body; int blen, status;
    char path[256];
    snprintf(path, sizeof(path), "/rpc/tags.json?token=%s", cfg.token);
    if (httpGet(path, &body, &blen, &status, NULL, 0) < 0) return;
    if (status == 200) parseTagLists(body, blen);
    free(body);
}

/* Run a queued one-shot remote action (save/block/list fetch). */
static void runAction(void) {
    int act = g_action;
    long id = g_action_id;
    g_action = ACT_NONE;
    if (act == ACT_LISTS) { fetchTagLists(); return; }
    if (id <= 0) return;

    char path[256];
    snprintf(path, sizeof(path), "/%s?id=%ld&token=%s",
             act == ACT_SAVE ? "save" : "block", id, cfg.token);
    unsigned char *body; int blen, status;
    if (httpGet(path, &body, &blen, &status, NULL, 0) < 0) {
        setToast(act == ACT_SAVE ? "save failed" : "block failed", 1, 3000);
        return;
    }
    free(body);
    if (status != 200) {
        char msg[48];
        snprintf(msg, sizeof(msg), "%s: HTTP %d",
                 act == ACT_SAVE ? "save" : "block", status);
        setToast(msg, 1, 3000);
        return;
    }
    if (act == ACT_SAVE) {
        setToast("saved", 0, 2000);
    } else {
        setToast("blocked", 0, 2000);
        histPurge(id);
        if (!g_ws_up) {
            g_req_id = -1;   /* the current post just got blocked — move on */
            g_req_replay = 0;
            g_want_next = 1;
        }
        /* ws mode: the server drops it from the queue and advances any
         * channel showing it — a playback frame is already on the way */
    }
}

/* ------------------------------------------------------------ ws session */

/* Cut panel power (kdisp on CFW) or fall back to a soft black screen,
 * then tell the server: `present` drives the channel park/dark-advance,
 * `reportDisplay` feeds the HA light entity. Runs on the ws thread. */
static void setDisplayPower(int s, int on, int report) {
    if (g_display_on == on) return;
    g_display_on = on;
    if (g_hw_display) kdispSetDisplay(on);
    if (!report) return;
    char msg[192];
    snprintf(msg, sizeof(msg),
             "{\"action\":\"present\",\"payload\":{\"deviceId\":\"%s\",\"present\":%s}}",
             cfg.device_id, on ? "true" : "false");
    wsSendText(s, msg);
    snprintf(msg, sizeof(msg),
             "{\"action\":\"reportDisplay\",\"payload\":{\"deviceId\":\"%s\",\"state\":\"%s\"}}",
             cfg.device_id, on ? "on" : "off");
    wsSendText(s, msg);
}

static void handleWsFrame(int s, const char *json) {
    char action[32];
    if (jsonStr(json, "action", action, sizeof(action)) < 0) return;

    if (!strcmp(action, "playback")) {
        char drv[64] = "";
        jsonStr(json, "mergeDriver", drv, sizeof(drv));
        g_we_are_driver = drv[0] && !strcmp(drv, cfg.device_id);

        const char *cur = strstr(json, "\"current\"");
        if (!cur) return;
        long id = jsonLong(cur, "id", 0);
        char ext[16] = "";
        jsonStr(cur, "ext", ext, sizeof(ext));
        if (id <= 0) return;

        if (extIsVideo(ext)) {
            /* Can't play video — confirm readiness so the channel dwells
             * normally instead of waiting out the readiness timeout. */
            if (g_last_ready_id != id) {
                g_last_ready_id = id;
                char msg[160];
                snprintf(msg, sizeof(msg),
                         "{\"sessionId\":\"" SESSION_ID "\",\"action\":\"imageReady\","
                         "\"payload\":{\"id\":%ld}}", id);
                wsSendText(s, msg);
                setToast("video post (not supported) - dwelling", 0, 3000);
            }
            return;
        }
        if (id == g_slot[g_front].id || id == g_req_id) return;
        g_req_id = id;
        g_req_replay = 0;
        g_want_next = 1;
    } else if (!strcmp(action, "tagLists")) {
        parseTagLists((const unsigned char *)json, (int)strlen(json));
    } else if (!strcmp(action, "displayState")) {
        char target[64] = "", state[16] = "";
        jsonStr(json, "target", target, sizeof(target));
        if (strcmp(target, cfg.device_id) != 0) return;
        const char *p = jsonFind(json, "state");
        int on;
        if (p && (*p == 't' || *p == 'f')) on = *p == 't';
        else if (jsonStr(json, "state", state, sizeof(state)) == 0)
            on = strcasecmp(state, "off") != 0;
        else return;
        setDisplayPower(s, on, 1);
    }
    /* pong / update / everything else: ignore */
}

static int wsThread(SceSize args, void *argp) {
    /* net init happens on the fetch thread; wait for it */
    while (g_running && !g_net_ready) sceKernelDelayThread(200 * 1000);

    int backoff_s = 2;
    while (g_running && !g_ws_denied) {
        char path[512];
        snprintf(path, sizeof(path), "/rpc/ws?token=%s", cfg.token);
        int s = wsConnect(cfg.host, cfg.port, path);
        if (s < 0) {
            sceKernelDelayThread(backoff_s * 1000 * 1000);
            if (backoff_s < 30) backoff_s *= 2;
            continue;
        }
        backoff_s = 2;

        /* Join the channel. The variant fingerprint must match our /get
         * parameters so server prefetch converts the right bytes. */
        char cfgmsg[384];
        snprintf(cfgmsg, sizeof(cfgmsg),
                 "{\"sessionId\":\"" SESSION_ID "\",\"action\":\"slideshowConfig\","
                 "\"payload\":{\"deviceId\":\"%s\",\"interval\":%d,"
                 "\"ratio\":1.765,\"width\":%d,\"height\":%d,"
                 "\"lowmem\":%s}}",
                 cfg.device_id, cfg.dwell_sec * 1000, SCR_W, SCR_H,
                 cfg.lowmem ? "true" : "false");
        if (wsSendText(s, cfgmsg) < 0) { wsClose(s); continue; }
        g_ws_up = 1;
        setToast("sync: connected", 0, 2000);

        static char rxbuf[24 * 1024];
        u64 last_rx, now, freq = sceRtcGetTickResolution();
        sceRtcGetCurrentTick(&last_rx);

        while (g_running) {
            while (g_outq_r != g_outq_w) {
                if (wsSendText(s, g_outq[g_outq_r]) < 0) goto drop;
                g_outq_r = (g_outq_r + 1) % OUTQ_N;
            }
            int code = 0;
            int n = wsPoll(s, rxbuf, sizeof(rxbuf), 200, &code);
            if (n < 0) {
                if (code == 1008) g_ws_denied = 1;
                break;
            }
            sceRtcGetCurrentTick(&now);
            if (n > 0) {
                last_rx = now;
                handleWsFrame(s, rxbuf);
            } else if ((now - last_rx) / freq > 45) {
                break; /* no traffic (broker pings every few s) — dead */
            }
        }
drop:
        g_ws_up = 0;
        g_we_are_driver = 0;
        wsClose(s);
        if (g_ws_denied) {
            setStatus("ws: token rejected (1008)", 1);
        } else if (g_running) {
            setToast("sync: reconnecting", 1, 3000);
            sceKernelDelayThread(2 * 1000 * 1000);
        }
    }
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
    g_net_ready = 1;

    int unsupported_streak = 0;
    while (g_running) {
        if (g_action != ACT_NONE) runAction();
        if (!g_want_next || g_incoming) {
            sceKernelDelayThread(50 * 1000);
            continue;
        }
        int back = g_front ^ 1;
        long want_id = g_req_id;
        int replay = g_req_replay;
        int rc = fetchImage(&g_slot[back], want_id, replay);
        if (rc == 0) {
            g_incoming_replay = replay;
            g_req_id = -1;
            g_req_replay = 0;
            g_want_next = 0;
            g_incoming = 1;
        } else if (rc == -2) {
            /* unsupported content: try another post right away, but don't
             * hammer a library that's mostly unsupported formats. A replay
             * of an unsupported id falls back to a fresh random pick. */
            g_req_id = -1;
            g_req_replay = 0;
            if (++unsupported_streak >= 4) {
                unsupported_streak = 0;
                sceKernelDelayThread(5 * 1000 * 1000);
            }
            continue;
        } else {
            sceKernelDelayThread(5 * 1000 * 1000); /* error → retry in 5 s */
        }
        unsupported_streak = 0;
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

/* Untextured translucent rectangle (text backdrops). Depth test must be
 * re-disabled here: intraFontPrint force-enables it on exit, so any rect
 * drawn after a text print would otherwise be culled. */
static void drawRect(int x0, int y0, int x1, int y1, unsigned int color) {
    sceGuDisable(GU_DEPTH_TEST);
    sceGuDisable(GU_TEXTURE_2D);
    Vertex *v = sceGuGetMemory(2 * sizeof(Vertex));
    v[0] = (Vertex){ 0, 0, color, (short)x0, (short)y0, 0 };
    v[1] = (Vertex){ 0, 0, color, (short)x1, (short)y1, 0 };
    sceKernelDcacheWritebackRange(v, 2 * sizeof(Vertex));
    sceGuDrawArray(GU_SPRITES, VFMT, 2, 0, v);
    sceGuEnable(GU_TEXTURE_2D);
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

    /* Kernel display-power helper: only loads on CFW; everywhere else we
     * soft-blank. Loaded before threads so g_hw_display is settled. */
    SceUID kmod = sceKernelLoadModule("kdisp.prx", 0, NULL);
    if (kmod >= 0) {
        int st;
        if (sceKernelStartModule(kmod, 0, NULL, &st, NULL) >= 0)
            g_hw_display = 1;
    }

    if (!cfg.host[0]) {
        setStatus("config.txt missing host= — see README", 1);
    } else {
        SceUID thid = sceKernelCreateThread("fetch", fetchThread, 0x25,
                                            0x40000, PSP_THREAD_ATTR_USER, 0);
        if (thid >= 0) sceKernelStartThread(thid, 0, 0);
        else setStatus("fetch thread failed", 1);
        SceUID wsid = sceKernelCreateThread("ws", wsThread, 0x26,
                                            0x10000, PSP_THREAD_ATTR_USER, 0);
        if (wsid >= 0) sceKernelStartThread(wsid, 0, 0);
    }

    u64 dwell_start = 0, tick_freq = sceRtcGetTickResolution();
    sceRtcGetCurrentTick(&dwell_start);
    int fade_frames = cfg.fade_ms / 17;  /* ~60 Hz */
    if (fade_frames < 1) fade_frames = 1;
    int fade_step = -1;                  /* -1 idle, else 0..fade_frames */
    int paused = 0;
    unsigned int prev_buttons = 0;
    int power_tick = 0;
    int list_mode = 0, list_sel = -1;
    long block_arm_id = 0;

    while (g_running) {
        /* --- input --- */
        SceCtrlData pad;
        sceCtrlPeekBufferPositive(&pad, 1);
        unsigned int pressed = pad.Buttons & ~prev_buttons;
        prev_buttons = pad.Buttons;
        int idle = fade_step < 0 && !g_want_next && !g_incoming;

        if (list_mode) {
            /* Tag-list picker: UP/DOWN cycle (auto → 0..n-1), X apply,
             * O or TRIANGLE cancel. */
            int n = g_lists_count;
            if (n > 0 && (pressed & PSP_CTRL_UP))
                list_sel = list_sel >= n - 1 ? -1 : list_sel + 1;
            if (n > 0 && (pressed & PSP_CTRL_DOWN))
                list_sel = list_sel <= -1 ? n - 1 : list_sel - 1;
            if (pressed & PSP_CTRL_CROSS) {
                g_active_list = list_sel;
                list_mode = 0;
                char msg[96];
                if (g_ws_up && list_sel >= 0) {
                    /* server-side: per-channel selection, next playback
                     * frame arrives against the new list */
                    snprintf(msg, sizeof(msg),
                             "{\"sessionId\":\"" SESSION_ID "\","
                             "\"action\":\"setTagList\","
                             "\"payload\":{\"listNumber\":%d}}", list_sel);
                    wsEnqueue(msg);
                    setToast("list sent to server", 0, 2000);
                } else {
                    if (list_sel < 0) snprintf(msg, sizeof(msg), "list: auto");
                    else snprintf(msg, sizeof(msg), "list %d selected", list_sel);
                    setToast(msg, 0, 2000);
                    if (idle) { g_req_id = -1; g_req_replay = 0; g_want_next = 1; }
                }
            }
            if (pressed & (PSP_CTRL_CIRCLE | PSP_CTRL_TRIANGLE)) list_mode = 0;
        } else {
            if ((pressed & PSP_CTRL_RIGHT) && idle) {
                if (g_hist_pos < g_hist_len - 1) { /* forward through history */
                    g_hist_pos++;
                    g_req_id = g_hist[g_hist_pos];
                    g_req_replay = 1;
                    g_want_next = 1;
                } else if (g_ws_up) {
                    /* server advances the channel; playback frame follows */
                    wsEnqueue("{\"sessionId\":\"" SESSION_ID "\","
                              "\"action\":\"requestNext\",\"payload\":{}}");
                } else {
                    g_req_id = -1;
                    g_req_replay = 0;
                    g_want_next = 1;
                }
            }
            if ((pressed & PSP_CTRL_LEFT) && idle) {
                if (g_hist_pos > 0) {
                    g_hist_pos--;
                    g_req_id = g_hist[g_hist_pos];
                    g_req_replay = 1;
                    g_want_next = 1;
                } else {
                    setToast("start of history", 0, 1500);
                }
            }
            if ((pressed & PSP_CTRL_CROSS) && g_have_image &&
                g_action == ACT_NONE) {
                g_action_id = g_slot[g_front].id;
                g_action = ACT_SAVE;
            }
            if ((pressed & PSP_CTRL_CIRCLE) && g_have_image &&
                g_action == ACT_NONE) {
                /* blocking is persistent — require a second press */
                if (block_arm_id == g_slot[g_front].id) {
                    g_action_id = g_slot[g_front].id;
                    g_action = ACT_BLOCK;
                    block_arm_id = 0;
                } else {
                    block_arm_id = g_slot[g_front].id;
                    setToast("press O again to block", 0, 3000);
                }
            }
            if (pressed & PSP_CTRL_TRIANGLE) {
                list_mode = 1;
                list_sel = g_active_list;
                if (g_lists_count < 0 && g_action == ACT_NONE)
                    g_action = ACT_LISTS;
            }
            if (pressed & PSP_CTRL_SQUARE) {
                if (g_ws_up) {
                    char msg[128];
                    snprintf(msg, sizeof(msg),
                             "{\"sessionId\":\"" SESSION_ID "\","
                             "\"action\":\"displaySync\","
                             "\"payload\":{\"enabled\":%s}}",
                             g_we_are_driver ? "false" : "true");
                    wsEnqueue(msg);
                    setToast(g_we_are_driver ? "releasing display sync"
                                             : "claiming display sync", 0, 2500);
                } else {
                    setToast("display sync needs the ws session", 1, 2500);
                }
            }
            if (pressed & PSP_CTRL_START) paused = !paused;
            if (pressed & PSP_CTRL_SELECT) cfg.clock_on = !cfg.clock_on;
        }

        /* --- dwell timer (standalone mode only — the server drives the
         * cadence through playback frames while the WS session is up) --- */
        u64 now;
        sceRtcGetCurrentTick(&now);
        if (!g_ws_up && g_display_on &&
            !paused && g_have_image && !g_want_next && !g_incoming &&
            fade_step < 0 &&
            (now - dwell_start) / tick_freq >= (u64)cfg.dwell_sec)
            g_want_next = 1;

        /* --- take incoming image, start crossfade --- */
        if (g_incoming && fade_step < 0) {
            fade_step = g_have_image ? 0 : fade_frames; /* first image: cut */
        }

        /* --- advance GIF animation on the visible slot --- */
        Slot *front = &g_slot[g_front];
        if (g_display_on && front->anim && front->nframes > 1 && fade_step < 0) {
            if (front->next_frame_tick == 0)
                front->next_frame_tick =
                    now + (u64)front->delays_ms[front->frame] * (tick_freq / 1000);
            if (now >= front->next_frame_tick) {
                int nf = (front->frame + 1) % front->nframes;
                slotShowFrame(front, nf);
                front->next_frame_tick =
                    now + (u64)front->delays_ms[nf] * (tick_freq / 1000);
            }
        }

        if (!(power_tick++ % 300)) scePowerTick(PSP_POWER_TICK_DISPLAY);

        /* --- draw --- */
        sceGuStart(GU_DIRECT, g_list);
        /* intraFontPrint force-enables the depth test on exit; our depth
         * buffer is never cleared, so anything drawn with it on is culled. */
        sceGuDisable(GU_DEPTH_TEST);
        sceGuClearColor(0xFF000000);
        sceGuClear(GU_COLOR_BUFFER_BIT);

        if (!g_display_on) {
            /* panel off (hw-dark on CFW, soft-black elsewhere): keep the
             * loop alive for WS/input, draw nothing */
        } else if (fade_step >= 0) {
            /* True crossfade: old fades out while new fades in, so an old
             * image wider than its successor doesn't linger at the edges
             * and pop out when the fade ends. */
            int a = fade_step * 255 / fade_frames;
            drawSlot(&g_slot[g_front], 255 - a);
            drawSlot(&g_slot[g_front ^ 1], a);
            if (fade_step++ >= fade_frames) {
                g_front ^= 1;
                g_incoming = 0;
                g_want_next = 0; /* drop any re-arm that raced the fade */
                g_have_image = 1;
                fade_step = -1;
                g_slot[g_front].next_frame_tick = 0;
                if (!g_incoming_replay) {
                    histAppend(g_slot[g_front].id);
                    /* server-driven mode: confirm the transition so the
                     * channel's dwell starts (readiness barrier) */
                    if (g_ws_up && g_last_ready_id != g_slot[g_front].id) {
                        g_last_ready_id = g_slot[g_front].id;
                        char msg[160];
                        snprintf(msg, sizeof(msg),
                                 "{\"sessionId\":\"" SESSION_ID "\","
                                 "\"action\":\"imageReady\","
                                 "\"payload\":{\"id\":%ld}}",
                                 g_slot[g_front].id);
                        wsEnqueue(msg);
                    }
                }
                g_incoming_replay = 0;
                block_arm_id = 0; /* image changed — disarm block confirm */
                sceRtcGetCurrentTick(&dwell_start);
            }
        } else {
            drawSlot(&g_slot[g_front], 255);
        }

        /* expire toasts */
        if (g_status[0] && g_status_until && now >= g_status_until) {
            g_status[0] = 0;
            g_status_until = 0;
        }

        if (font && g_display_on) {
            intraFontActivate(font);
            if (list_mode) {
                drawRect(40, 96, SCR_W - 40, 176, 0xC0000000);
                char line[96];
                if (g_lists_count < 0) {
                    snprintf(line, sizeof(line), "Tag list: loading...");
                } else if (list_sel < 0) {
                    snprintf(line, sizeof(line), "Tag list: auto (server default)");
                } else {
                    snprintf(line, sizeof(line), "Tag list %d of %d: %.44s",
                             list_sel, g_lists_count - 1,
                             g_list_preview[list_sel][0]
                                 ? g_list_preview[list_sel] : "(empty)");
                }
                intraFontSetStyle(font, 0.9f, 0xFFFFFFFF, 0xFF000000,
                                  0.0f, INTRAFONT_ALIGN_CENTER);
                intraFontPrint(font, SCR_W / 2, 124, line);
                intraFontSetStyle(font, 0.7f, 0xDDCCCCCC, 0xFF000000,
                                  0.0f, INTRAFONT_ALIGN_CENTER);
                intraFontPrint(font, SCR_W / 2, 156,
                               "UP/DOWN change   X apply   O cancel");
            }
            if (cfg.clock_on) {
                ScePspDateTime t;
                sceRtcGetCurrentClockLocalTime(&t);
                char clk[8];
                snprintf(clk, sizeof(clk), "%02d:%02d", t.hour, t.minute);
                intraFontSetStyle(font, cfg.clock_size, 0xDDFFFFFF, 0xFF000000,
                                  0.0f, INTRAFONT_ALIGN_RIGHT);
                int tw = (int)intraFontMeasureText(font, clk);
                int th = (int)(16.0f * cfg.clock_size);
                drawRect(SCR_W - 8 - tw - 6, SCR_H - 10 - th - 2,
                         SCR_W - 8 + 6, SCR_H - 10 + 6, 0x90000000);
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
