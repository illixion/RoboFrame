#include <arpa/inet.h>
#include <netinet/in.h>
#include <sys/socket.h>
#include <sys/select.h>
#include <unistd.h>
#include <errno.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

#include <pspnet_resolver.h>
#include <psprtc.h>

#include "ws.h"

/* PSP inet sockets act non-blocking under PPSSPP: every recv/send goes
 * through select() + EAGAIN retry, same as the HTTP client in main.c. */

static int wsRecvWait(int s, void *buf, int len, int timeout_ms) {
    for (;;) {
        fd_set rf;
        FD_ZERO(&rf);
        FD_SET(s, &rf);
        struct timeval tv = { .tv_sec = timeout_ms / 1000,
                              .tv_usec = (timeout_ms % 1000) * 1000 };
        int r = select(s + 1, &rf, NULL, NULL, &tv);
        if (r == 0) return 0;   /* timeout */
        if (r < 0) return -1;
        int n = recv(s, buf, len, 0);
        if (n < 0 && (errno == EAGAIN || errno == EWOULDBLOCK)) continue;
        if (n <= 0) return -1;  /* closed or error */
        return n;
    }
}

/* Blocking-until-complete recv of exactly len bytes (15 s cap). */
static int wsRecvAll(int s, unsigned char *buf, int len) {
    int got = 0;
    while (got < len) {
        int n = wsRecvWait(s, buf + got, len - got, 15000);
        if (n <= 0) return -1;
        got += n;
    }
    return len;
}

static int wsSendAll(int s, const void *buf, int len) {
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

static int wsResolve(const char *host, struct in_addr *out) {
    if (inet_aton(host, out)) return 0;
    int rid = -1;
    char rbuf[1024];
    if (sceNetResolverCreate(&rid, rbuf, sizeof(rbuf)) < 0) return -1;
    int rc = sceNetResolverStartNtoA(rid, host, out, 5 * 1000 * 1000, 3);
    sceNetResolverDelete(rid);
    return rc;
}

static void b64(const unsigned char *in, int len, char *out) {
    static const char T[] =
        "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    int o = 0;
    for (int i = 0; i < len; i += 3) {
        unsigned v = in[i] << 16;
        if (i + 1 < len) v |= in[i + 1] << 8;
        if (i + 2 < len) v |= in[i + 2];
        out[o++] = T[(v >> 18) & 63];
        out[o++] = T[(v >> 12) & 63];
        out[o++] = i + 1 < len ? T[(v >> 6) & 63] : '=';
        out[o++] = i + 2 < len ? T[v & 63] : '=';
    }
    out[o] = 0;
}

int wsConnect(const char *host, int port, const char *path_and_query) {
    struct in_addr addr;
    if (wsResolve(host, &addr) < 0) return -1;

    int s = socket(AF_INET, SOCK_STREAM, 0);
    if (s < 0) return -1;

    struct sockaddr_in sin;
    memset(&sin, 0, sizeof(sin));
    sin.sin_family = AF_INET;
    sin.sin_port = htons(port);
    sin.sin_addr = addr;
    if (connect(s, (struct sockaddr *)&sin, sizeof(sin)) < 0) {
        if (errno == EINPROGRESS || errno == EAGAIN || errno == EWOULDBLOCK) {
            fd_set wf;
            FD_ZERO(&wf);
            FD_SET(s, &wf);
            struct timeval tv = { .tv_sec = 15, .tv_usec = 0 };
            if (select(s + 1, NULL, &wf, NULL, &tv) <= 0) { close(s); return -1; }
        } else {
            close(s);
            return -1;
        }
    }

    /* Nonce quality doesn't matter here (LAN, no intermediaries — the
     * key exists to defeat caching proxies), so RTC ticks are fine. */
    unsigned char nonce[16];
    u64 t;
    sceRtcGetCurrentTick(&t);
    for (int i = 0; i < 16; i++) nonce[i] = (unsigned char)(t >> ((i % 8) * 8)) ^ (i * 37);
    char key[32];
    b64(nonce, 16, key);

    char req[512];
    int rl = snprintf(req, sizeof(req),
                      "GET %s HTTP/1.1\r\n"
                      "Host: %s:%d\r\n"
                      "Upgrade: websocket\r\n"
                      "Connection: Upgrade\r\n"
                      "Sec-WebSocket-Key: %s\r\n"
                      "Sec-WebSocket-Version: 13\r\n\r\n",
                      path_and_query, host, port, key);
    if (wsSendAll(s, req, rl) != rl) { close(s); return -1; }

    /* Read the 101 response headers. We skip Sec-WebSocket-Accept
     * verification (needs SHA-1) — we only ever talk to our own broker
     * over the LAN, and a wrong peer fails at the first JSON frame. */
    char hdr[2048];
    int hlen = 0;
    while (hlen < (int)sizeof(hdr) - 1) {
        int n = wsRecvWait(s, hdr + hlen, sizeof(hdr) - 1 - hlen, 15000);
        if (n <= 0) { close(s); return -1; }
        hlen += n;
        hdr[hlen] = 0;
        if (strstr(hdr, "\r\n\r\n")) break;
    }
    if (strncmp(hdr, "HTTP/1.1 101", 12) != 0) { close(s); return -1; }
    /* Anything after the header terminator is already frame data; the
     * broker never speaks first within the same packet as the 101 in
     * practice (ws sends the upgrade response on its own write). */
    return s;
}

int wsSendText(int s, const char *msg) {
    int len = (int)strlen(msg);
    if (len > 60000) return -1;
    unsigned char hdr[8];
    int hl = 0;
    hdr[hl++] = 0x81;                       /* FIN | text */
    if (len < 126) {
        hdr[hl++] = 0x80 | len;             /* MASK | len */
    } else {
        hdr[hl++] = 0x80 | 126;
        hdr[hl++] = len >> 8;
        hdr[hl++] = len & 0xFF;
    }
    unsigned char mask[4];
    u64 t;
    sceRtcGetCurrentTick(&t);
    mask[0] = t; mask[1] = t >> 8; mask[2] = t >> 17; mask[3] = t >> 25;
    memcpy(hdr + hl, mask, 4);
    hl += 4;

    unsigned char *frame = malloc(hl + len);
    if (!frame) return -1;
    memcpy(frame, hdr, hl);
    for (int i = 0; i < len; i++)
        frame[hl + i] = (unsigned char)msg[i] ^ mask[i & 3];
    int rc = wsSendAll(s, frame, hl + len) == hl + len ? 0 : -1;
    free(frame);
    return rc;
}

/* Send a masked control frame (pong/close) with a small payload. */
static int wsSendControl(int s, int opcode, const unsigned char *pay, int len) {
    unsigned char frame[2 + 4 + 125];
    if (len > 125) len = 125;
    frame[0] = 0x80 | opcode;
    frame[1] = 0x80 | len;
    unsigned char mask[4] = { 0x12, 0x34, 0x56, 0x78 };
    memcpy(frame + 2, mask, 4);
    for (int i = 0; i < len; i++) frame[6 + i] = pay[i] ^ mask[i & 3];
    return wsSendAll(s, frame, 6 + len) == 6 + len ? 0 : -1;
}

int wsPoll(int s, char *buf, int buflen, int timeout_ms, int *close_code) {
    if (close_code) *close_code = 0;
    int mlen = 0; /* accumulated message length across continuations */

    for (;;) {
        unsigned char h[2];
        int n = wsRecvWait(s, h, 1, timeout_ms);
        if (n == 0) return mlen ? 0 : 0;   /* timeout */
        if (n < 0) return -1;
        if (wsRecvAll(s, h + 1, 1) < 0) return -1;

        int fin = h[0] & 0x80;
        int opcode = h[0] & 0x0F;
        if (h[1] & 0x80) return -1;        /* server frames are unmasked */
        long plen = h[1] & 0x7F;
        if (plen == 126) {
            unsigned char e[2];
            if (wsRecvAll(s, e, 2) < 0) return -1;
            plen = (e[0] << 8) | e[1];
        } else if (plen == 127) {
            unsigned char e[8];
            if (wsRecvAll(s, e, 8) < 0) return -1;
            plen = ((long)e[4] << 24) | (e[5] << 16) | (e[6] << 8) | e[7];
        }

        if (opcode == 0x9) {               /* ping → pong, keep reading */
            unsigned char pay[125];
            if (plen > 125 || wsRecvAll(s, pay, plen) < 0) return -1;
            wsSendControl(s, 0xA, pay, plen);
            timeout_ms = 0;
            continue;
        }
        if (opcode == 0xA) {               /* pong: swallow */
            unsigned char pay[125];
            if (plen > 125 || wsRecvAll(s, pay, plen) < 0) return -1;
            timeout_ms = 0;
            continue;
        }
        if (opcode == 0x8) {               /* close */
            unsigned char pay[125];
            int cl = plen > 125 ? 125 : plen;
            if (wsRecvAll(s, pay, cl) < 0) return -1;
            if (close_code && cl >= 2) *close_code = (pay[0] << 8) | pay[1];
            wsSendControl(s, 0x8, pay, cl >= 2 ? 2 : 0);
            return -1;
        }

        /* text (0x1) or continuation (0x0); binary is never sent by the
         * broker but drain it anyway to stay in sync */
        if (mlen + plen >= buflen) {       /* oversized: drain + drop */
            unsigned char sink[512];
            while (plen > 0) {
                int chunk = plen > (long)sizeof(sink) ? (int)sizeof(sink) : (int)plen;
                if (wsRecvAll(s, sink, chunk) < 0) return -1;
                plen -= chunk;
            }
            if (fin) mlen = 0;
            timeout_ms = 0;
            continue;
        }
        if (plen > 0 && wsRecvAll(s, (unsigned char *)buf + mlen, plen) < 0)
            return -1;
        mlen += plen;
        if (fin) {
            buf[mlen] = 0;
            return mlen;
        }
        timeout_ms = 15000; /* mid-message: wait for the rest */
    }
}

void wsClose(int s) {
    wsSendControl(s, 0x8, NULL, 0);
    close(s);
}
