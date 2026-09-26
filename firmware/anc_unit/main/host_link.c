#include "host_link.h"

#include <stdatomic.h>
#include <string.h>

#include "audio_config.h"
#include "driver/usb_serial_jtag.h"
#include "esp_check.h"
#include "freertos/FreeRTOS.h"
#include "freertos/ringbuf.h"
#include "freertos/task.h"

static const char *TAG = "host_link";

#define FRAME_BYTES (LINK_HEADER_BYTES + AUDIO_BLOCK_FRAMES * 2 * LINK_SAMPLE_BYTES)
/* ~400 ms of slack for the USB side to fall behind before anything drops. */
#define RING_BLOCKS 40

static RingbufHandle_t s_ring;
static atomic_bool s_streaming;
static atomic_uint_fast32_t s_seq;
static atomic_uint_fast32_t s_dropped;
static atomic_uint_fast32_t s_sent;

static void put_u16(uint8_t *p, uint16_t v)
{
    p[0] = v & 0xff;
    p[1] = v >> 8;
}

static void put_u32(uint8_t *p, uint32_t v)
{
    for (int i = 0; i < 4; i++) {
        p[i] = (v >> (8 * i)) & 0xff;
    }
}

static void put_s24(uint8_t *p, int32_t v)
{
    p[0] = v & 0xff;
    p[1] = (v >> 8) & 0xff;
    p[2] = (v >> 16) & 0xff;
}

static void writer_task(void *arg)
{
    (void)arg;
    for (;;) {
        size_t size = 0;
        uint8_t *item = xRingbufferReceive(s_ring, &size, pdMS_TO_TICKS(50));
        if (item == NULL) {
            continue;
        }
        int written = usb_serial_jtag_write_bytes(item, size, pdMS_TO_TICKS(100));
        vRingbufferReturnItem(s_ring, item);
        if (written == (int)size) {
            atomic_fetch_add(&s_sent, 1);
        } else {
            /* Host not reading (port closed or too slow). */
            atomic_fetch_add(&s_dropped, 1);
        }
    }
}

esp_err_t host_link_init(void)
{
    usb_serial_jtag_driver_config_t cfg = {
        .tx_buffer_size = 4096,
        .rx_buffer_size = 256,
    };
    ESP_RETURN_ON_ERROR(usb_serial_jtag_driver_install(&cfg), TAG, "usb serial jtag");

    s_ring = xRingbufferCreate(RING_BLOCKS * (FRAME_BYTES + 8), RINGBUF_TYPE_NOSPLIT);
    ESP_RETURN_ON_FALSE(s_ring != NULL, ESP_ERR_NO_MEM, TAG, "ring buffer");

    /* Core 0, below the audio task: USB may stall, audio must not. */
    BaseType_t ok = xTaskCreatePinnedToCore(writer_task, "link_tx", 4096, NULL, 5, NULL, 0);
    ESP_RETURN_ON_FALSE(ok == pdPASS, ESP_ERR_NO_MEM, TAG, "writer task");
    return ESP_OK;
}

link_cmd_t host_link_poll_command(void)
{
    uint8_t c;
    while (usb_serial_jtag_read_bytes(&c, 1, 0) == 1) {
        switch (c) {
        case 'I': return LINK_CMD_INFO;
        case 'R': return LINK_CMD_START;
        case 'P': return LINK_CMD_START_CLEANED;
        case 'S': return LINK_CMD_STOP;
        default: break; /* ignore newlines and noise */
        }
    }
    return LINK_CMD_NONE;
}

void host_link_set_streaming(bool on)
{
    if (on) {
        atomic_store(&s_seq, 0);
        atomic_store(&s_dropped, 0);
        atomic_store(&s_sent, 0);
    }
    atomic_store(&s_streaming, on);
}

bool host_link_streaming(void)
{
    return atomic_load(&s_streaming);
}

void host_link_push_block(const int32_t *primary, const int32_t *second, size_t frames)
{
    if (!atomic_load(&s_streaming)) {
        return;
    }
    static uint8_t frame[FRAME_BYTES];
    uint32_t seq = atomic_fetch_add(&s_seq, 1);
    uint32_t dropped = atomic_load(&s_dropped);

    memcpy(frame, LINK_MAGIC, 4);
    put_u32(frame + 4, seq);
    put_u16(frame + 8, (uint16_t)frames);
    put_u16(frame + 10, dropped > 0xffff ? 0xffff : (uint16_t)dropped);
    uint8_t *p = frame + LINK_HEADER_BYTES;
    for (size_t i = 0; i < frames; i++) {
        put_s24(p, primary[i]);
        put_s24(p + 3, second[i]);
        p += 2 * LINK_SAMPLE_BYTES;
    }
    size_t len = LINK_HEADER_BYTES + frames * 2 * LINK_SAMPLE_BYTES;
    if (xRingbufferSend(s_ring, frame, len, 0) != pdTRUE) {
        atomic_fetch_add(&s_dropped, 1);
    }
}

uint32_t host_link_blocks_sent(void)
{
    return atomic_load(&s_sent);
}

uint32_t host_link_blocks_dropped(void)
{
    return atomic_load(&s_dropped);
}

void host_link_send_line(const char *line)
{
    if (atomic_load(&s_streaming)) {
        return;
    }
    usb_serial_jtag_write_bytes(line, strlen(line), pdMS_TO_TICKS(100));
}
