#pragma once

#include <stdbool.h>
#include <stddef.h>
#include <stdint.h>

#include "esp_err.h"

/*
 * Recording protocol over the native USB port (USB-Serial-JTAG).
 * Mirrored by src/anc/link.py; change both together.
 *
 * Host -> device: single ASCII bytes.
 *   'I'  reply with one info line (only while not streaming)
 *   'R'  start streaming: primary mic + reference mic (training data)
 *   'P'  start streaming: primary mic + cleaned output (before/after test;
 *        the cleaned channel lags the primary by the canceller delay)
 *   'S'  stop streaming
 *
 * Device -> host while streaming, one frame per 10 ms block:
 *   "ANCF"            4 bytes  magic
 *   seq               uint32   block counter since 'R', counts dropped blocks too
 *   nframes           uint16   stereo frames in this block (160)
 *   dropped           uint16   blocks dropped since 'R', saturates at 65535
 *   payload           nframes x (primary, reference) x 24-bit little-endian
 *
 * A gap in seq tells the host exactly how many blocks were lost and where.
 */

#define LINK_MAGIC        "ANCF"
#define LINK_HEADER_BYTES 12
#define LINK_SAMPLE_BYTES 3

typedef enum {
    LINK_CMD_NONE,
    LINK_CMD_INFO,
    LINK_CMD_START,
    LINK_CMD_START_CLEANED,
    LINK_CMD_STOP,
} link_cmd_t;

esp_err_t host_link_init(void);

/* Non-blocking. Returns the next command byte received, if any. */
link_cmd_t host_link_poll_command(void);

void host_link_set_streaming(bool on);
bool host_link_streaming(void);

/* Called from the audio task. Never blocks: if the USB side is behind, the
 * block is dropped and counted rather than stalling audio capture. `second`
 * is the reference mic or the cleaned output, depending on the command. */
void host_link_push_block(const int32_t *primary, const int32_t *second, size_t frames);

uint32_t host_link_blocks_sent(void);
uint32_t host_link_blocks_dropped(void);

/* Sends one text line. Ignored while streaming. */
void host_link_send_line(const char *line);
