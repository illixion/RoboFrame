#ifndef PSPKIOSK_WS_H
#define PSPKIOSK_WS_H

/* Minimal RFC 6455 client over PSP inet sockets. Text frames only
 * (the RoboFrame protocol is all JSON text); control frames are
 * handled internally. Not thread-safe — one owner thread per socket. */

/* Open TCP + upgrade. Returns socket fd, or -1 on failure. */
int wsConnect(const char *host, int port, const char *path_and_query);

/* Send one text message. Returns 0, or -1 on transport failure. */
int wsSendText(int s, const char *msg);

/* Wait up to timeout_ms for a complete text message. Returns message
 * length (>0, NUL-terminated into buf), 0 on timeout/no-data, -1 when
 * the connection is dead. Server CLOSE frames set *close_code (0
 * otherwise) and return -1 after echoing the close. */
int wsPoll(int s, char *buf, int buflen, int timeout_ms, int *close_code);

void wsClose(int s);

#endif
