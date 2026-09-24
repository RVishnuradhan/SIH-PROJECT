/*
 * Firmware v0: wiring check and data collection.
 *
 * - Captures both INMP441s continuously on core 1.
 * - Button cycles what the speaker plays: MUTE -> PRIMARY -> REFERENCE -> MUTE.
 *   Hearing each mic separately is the quickest way to confirm the wiring.
 * - Over the native USB port, the host can ask for mic levels ('I') and
 *   record both mics ('R' / 'S'). See tools/record.py.
 *
 * No noise cancellation yet; that is firmware v1.
 */
#include <math.h>
#include <stdatomic.h>
#include <stdio.h>

#include "audio_config.h"
#include "audio_io.h"
#include "board.h"
#include "esp_log.h"
#include "esp_psram.h"
#include "freertos/FreeRTOS.h"
#include "freertos/task.h"
#include "host_link.h"

#define FW_VERSION "0.1.0"

static const char *TAG = "main";

/* +18 dB over the raw 24->16-bit conversion. INMP441 speech at arm's length
 * sits around -45 dBFS, which is inaudible without some gain. */
#define MONITOR_GAIN_SHIFT 3

/* Levels are averaged over this many blocks (0.5 s) before publishing. */
#define LEVEL_BLOCKS 50

typedef enum { MON_MUTE, MON_PRIMARY, MON_REFERENCE, MON_COUNT } monitor_t;
static const char *MON_NAMES[MON_COUNT] = {"mute", "primary", "reference"};

static atomic_int s_monitor = MON_MUTE;
static _Atomic float s_level_primary_db = -200.0f;
static _Atomic float s_level_reference_db = -200.0f;

static float to_dbfs(double sum_sq, int n)
{
    if (sum_sq <= 0.0) {
        return -200.0f; /* dead mic or all-zero data: usually a wiring fault */
    }
    double rms = sqrt(sum_sq / n) / AUDIO_FULL_SCALE_24;
    return (float)(20.0 * log10(rms));
}

static int16_t to_monitor_sample(int32_t s24)
{
    int32_t v = s24 >> (8 - MONITOR_GAIN_SHIFT);
    if (v > INT16_MAX) return INT16_MAX;
    if (v < INT16_MIN) return INT16_MIN;
    return (int16_t)v;
}

static void audio_task(void *arg)
{
    (void)arg;
    static int32_t primary[AUDIO_BLOCK_FRAMES];
    static int32_t reference[AUDIO_BLOCK_FRAMES];
    static int16_t out[AUDIO_BLOCK_FRAMES];
    double acc_p = 0, acc_r = 0;
    int acc_blocks = 0;

    for (;;) {
        if (audio_io_read(primary, reference, AUDIO_BLOCK_FRAMES) != ESP_OK) {
            ESP_LOGW(TAG, "mic read failed");
            continue;
        }

        host_link_push_block(primary, reference, AUDIO_BLOCK_FRAMES);

        for (int i = 0; i < AUDIO_BLOCK_FRAMES; i++) {
            acc_p += (double)primary[i] * primary[i];
            acc_r += (double)reference[i] * reference[i];
        }
        if (++acc_blocks == LEVEL_BLOCKS) {
            int n = LEVEL_BLOCKS * AUDIO_BLOCK_FRAMES;
            atomic_store(&s_level_primary_db, to_dbfs(acc_p, n));
            atomic_store(&s_level_reference_db, to_dbfs(acc_r, n));
            acc_p = acc_r = 0;
            acc_blocks = 0;
        }

        /* Always write a block, silent or not, so the amp clock never stalls. */
        monitor_t mon = atomic_load(&s_monitor);
        const int32_t *src = mon == MON_PRIMARY ? primary : mon == MON_REFERENCE ? reference : NULL;
        for (int i = 0; i < AUDIO_BLOCK_FRAMES; i++) {
            out[i] = src ? to_monitor_sample(src[i]) : 0;
        }
        audio_io_write_mono(out, AUDIO_BLOCK_FRAMES);
    }
}

static void apply_amp_state(void)
{
    /* The speaker stays off while recording, so it can never leak into the
     * recording and become part of the training data. */
    bool on = atomic_load(&s_monitor) != MON_MUTE && !host_link_streaming();
    audio_io_amp_enable(on);
}

static void send_info(void)
{
    char line[256];
    snprintf(line, sizeof(line),
             "ANC fw=%s fs=%d block=%d psram=%u monitor=%s "
             "lvl_primary=%.1f lvl_reference=%.1f\n",
             FW_VERSION, AUDIO_SAMPLE_RATE, AUDIO_BLOCK_FRAMES,
             (unsigned)esp_psram_get_size(), MON_NAMES[atomic_load(&s_monitor)],
             atomic_load(&s_level_primary_db), atomic_load(&s_level_reference_db));
    host_link_send_line(line);
}

static void init_button(void)
{
    gpio_config_t cfg = {
        .pin_bit_mask = 1ULL << PIN_BUTTON,
        .mode = GPIO_MODE_INPUT,
        .pull_up_en = GPIO_PULLUP_ENABLE,
    };
    ESP_ERROR_CHECK(gpio_config(&cfg));
}

/* Returns true once per press, after 30 ms of stable low. */
static bool button_pressed(void)
{
    static int stable_ms = 0;
    static bool latched = false;
    if (gpio_get_level(PIN_BUTTON) == 0) {
        stable_ms += 10;
        if (stable_ms >= 30 && !latched) {
            latched = true;
            return true;
        }
    } else {
        stable_ms = 0;
        latched = false;
    }
    return false;
}

void app_main(void)
{
    ESP_LOGI(TAG, "ANC unit firmware %s", FW_VERSION);
    ESP_ERROR_CHECK(audio_io_init());
    ESP_ERROR_CHECK(host_link_init());
    init_button();

    /* Core 1, high priority: nothing else runs there, so capture never waits
     * on USB, WiFi or the display. */
    xTaskCreatePinnedToCore(audio_task, "audio", 8192, NULL, configMAX_PRIORITIES - 2, NULL, 1);

    for (;;) {
        switch (host_link_poll_command()) {
        case LINK_CMD_INFO:
            send_info();
            break;
        case LINK_CMD_START:
            host_link_set_streaming(true);
            apply_amp_state();
            ESP_LOGI(TAG, "recording started");
            break;
        case LINK_CMD_STOP:
            host_link_set_streaming(false);
            apply_amp_state();
            ESP_LOGI(TAG, "recording stopped: %lu sent, %lu dropped",
                     (unsigned long)host_link_blocks_sent(),
                     (unsigned long)host_link_blocks_dropped());
            break;
        case LINK_CMD_NONE:
            break;
        }

        if (button_pressed()) {
            atomic_store(&s_monitor, (atomic_load(&s_monitor) + 1) % MON_COUNT);
            apply_amp_state();
            ESP_LOGI(TAG, "monitor: %s", MON_NAMES[atomic_load(&s_monitor)]);
        }

        vTaskDelay(pdMS_TO_TICKS(10));
    }
}
