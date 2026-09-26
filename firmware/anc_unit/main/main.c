/*
 * Firmware v3: two-mic noise canceller followed by the neural noise
 * suppressor, both running on the device (no network needed).
 *
 * Audio task (core 1), every 10 ms block:
 *   both mics -> level-ratio speech detector -> gated NLMS canceller
 *   (freeze during speech, 150 ms rollback, divergence guard)
 *   -> neural suppressor (anc_denoise, weights in main/denoiser.bin) -> speaker.
 *
 * BOOT button cycles the speaker: mute -> raw (primary mic) -> ai (full
 * chain) -> two-mic (canceller only) -> reference mic -> mute. Raw vs ai is
 * the demo; the reference position is for checking wiring.
 *
 * Native USB port (tools/record.py):
 *   'I' info line with levels, detector state and processing time
 *   'R' record primary + reference (training data)
 *   'P' record primary + final output (before/after test); the output lags
 *       by out_delay samples, reported in the info line
 *   'S' stop
 */
#include <math.h>
#include <stdatomic.h>
#include <stdio.h>

#include "anc_core.h"
#include "anc_denoise.h"
#include "audio_config.h"
#include "audio_io.h"
#include "board.h"
#include "esp_heap_caps.h"
#include "esp_log.h"
#include "esp_psram.h"
#include "esp_timer.h"
#include "freertos/FreeRTOS.h"
#include "freertos/task.h"
#include "host_link.h"

#define FW_VERSION "0.3.0"

static const char *TAG = "main";

/* +18 dB over the raw 24->16-bit conversion. INMP441 speech at arm's length
 * sits around -45 dBFS, which is inaudible without some gain. */
#define MONITOR_GAIN (1 << 3)

/* Levels are averaged over this many blocks (0.5 s) before publishing. */
#define LEVEL_BLOCKS 50

typedef enum { MON_MUTE, MON_RAW, MON_AI, MON_TWOMIC, MON_REFERENCE, MON_COUNT } monitor_t;
static const char *MON_NAMES[MON_COUNT] = {"mute", "raw", "ai", "two-mic", "reference"};

/* Deepest cut per frequency: -30 dB turns noise well down without the
 * "underwater" sound of cutting it to nothing. Same as anc.denoiser.denoise. */
#define AI_FLOOR_DB (-30.0f)

/* Weights exported by tools/export_denoiser.py, linked into the app. */
extern const uint8_t denoiser_bin_start[] asm("_binary_denoiser_bin_start");
extern const uint8_t denoiser_bin_end[] asm("_binary_denoiser_bin_end");

typedef enum { STREAM_MICS, STREAM_CLEANED } stream_t;

static atomic_int s_monitor = MON_MUTE;
static atomic_int s_stream = STREAM_MICS;
static _Atomic float s_level_primary_db = -200.0f;
static _Atomic float s_level_reference_db = -200.0f;
static _Atomic float s_level_cleaned_db = -200.0f;
static _Atomic float s_level_ai_db = -200.0f;
static _Atomic float s_ai_gain = 1.0f;
static _Atomic float s_ratio_db = 0.0f;
static atomic_bool s_speech;
static atomic_uint s_rollbacks, s_guard_trips;
static atomic_uint s_proc_us_max;     /* worst processing time per 10 ms block, last 0.5 s */
static atomic_uint s_ai_us_max;       /* the neural suppressor's share of it */

static anc_canceller_t s_anc;
static anc_vad_t s_vad;
static anc_denoise_t s_dn;
static bool s_dn_ok;                  /* false: bad or missing weights, output = canceller */

static float to_dbfs(double sum_sq, int n)
{
    if (sum_sq <= 0.0) {
        return -200.0f; /* dead mic or all-zero data: usually a wiring fault */
    }
    return (float)(20.0 * log10(sqrt(sum_sq / n)));
}

static int16_t to_monitor_sample(float v)
{
    float s = v * 32768.0f * MONITOR_GAIN;
    if (s > INT16_MAX) return INT16_MAX;
    if (s < INT16_MIN) return INT16_MIN;
    return (int16_t)s;
}

static int32_t to_s24(float v)
{
    float s = v * AUDIO_FULL_SCALE_24;
    if (s > 8388607.0f) return 8388607;
    if (s < -8388608.0f) return -8388608;
    return (int32_t)s;
}

static void audio_task(void *arg)
{
    (void)arg;
    static int32_t primary[AUDIO_BLOCK_FRAMES], reference[AUDIO_BLOCK_FRAMES];
    static float p[AUDIO_BLOCK_FRAMES], r[AUDIO_BLOCK_FRAMES], clean[AUDIO_BLOCK_FRAMES];
    static float ai[AUDIO_BLOCK_FRAMES];
    static int32_t final24[AUDIO_BLOCK_FRAMES];
    static int16_t out[AUDIO_BLOCK_FRAMES];
    double acc_p = 0, acc_r = 0, acc_c = 0, acc_a = 0;
    int acc_blocks = 0;
    uint32_t proc_max = 0, ai_max = 0;

    for (;;) {
        if (audio_io_read(primary, reference, AUDIO_BLOCK_FRAMES) != ESP_OK) {
            ESP_LOGW(TAG, "mic read failed");
            continue;
        }
        for (int i = 0; i < AUDIO_BLOCK_FRAMES; i++) {
            p[i] = primary[i] / AUDIO_FULL_SCALE_24;
            r[i] = reference[i] / AUDIO_FULL_SCALE_24;
        }

        int64_t t0 = esp_timer_get_time();
        anc_canceller_process_block(&s_anc, p, r, clean);
        if (anc_vad_feed(&s_vad, p, r, AUDIO_BLOCK_FRAMES)) {
            anc_canceller_set_speech(&s_anc, s_vad.speech);   /* applies from the next block */
            atomic_store(&s_speech, s_vad.speech);
            atomic_store(&s_ratio_db, s_vad.last_ratio_db);
        }
        int64_t t1 = esp_timer_get_time();
        const float *final = clean;
        if (s_dn_ok) {
            anc_denoise_process(&s_dn, clean, ai);
            final = ai;
        }
        int64_t t2 = esp_timer_get_time();
        if ((uint32_t)(t2 - t0) > proc_max) proc_max = (uint32_t)(t2 - t0);
        if ((uint32_t)(t2 - t1) > ai_max) ai_max = (uint32_t)(t2 - t1);

        if (atomic_load(&s_stream) == STREAM_CLEANED) {
            for (int i = 0; i < AUDIO_BLOCK_FRAMES; i++) final24[i] = to_s24(final[i]);
            host_link_push_block(primary, final24, AUDIO_BLOCK_FRAMES);
        } else {
            host_link_push_block(primary, reference, AUDIO_BLOCK_FRAMES);
        }

        for (int i = 0; i < AUDIO_BLOCK_FRAMES; i++) {
            acc_p += (double)p[i] * p[i];
            acc_r += (double)r[i] * r[i];
            acc_c += (double)clean[i] * clean[i];
            acc_a += (double)final[i] * final[i];
        }
        if (++acc_blocks == LEVEL_BLOCKS) {
            int n = LEVEL_BLOCKS * AUDIO_BLOCK_FRAMES;
            atomic_store(&s_level_primary_db, to_dbfs(acc_p, n));
            atomic_store(&s_level_reference_db, to_dbfs(acc_r, n));
            atomic_store(&s_level_cleaned_db, to_dbfs(acc_c, n));
            atomic_store(&s_level_ai_db, to_dbfs(acc_a, n));
            atomic_store(&s_ai_gain, s_dn_ok ? anc_denoise_mean_gain(&s_dn) : 1.0f);
            atomic_store(&s_rollbacks, s_anc.rollbacks);
            atomic_store(&s_guard_trips, s_anc.guard_trips);
            atomic_store(&s_proc_us_max, proc_max);
            atomic_store(&s_ai_us_max, ai_max);
            acc_p = acc_r = acc_c = acc_a = 0;
            acc_blocks = 0;
            proc_max = ai_max = 0;
        }

        /* Always write a block, silent or not, so the amp clock never stalls. */
        monitor_t mon = atomic_load(&s_monitor);
        const float *src = mon == MON_RAW ? p : mon == MON_AI ? final
                         : mon == MON_TWOMIC ? clean : mon == MON_REFERENCE ? r : NULL;
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
    char line[400];
    /* out_delay: samples the 'P' output lags the primary mic by (canceller
     * delay, plus the suppressor's when it runs). */
    int out_delay = s_anc.cfg.delay + (s_dn_ok ? anc_denoise_latency(&s_dn) : 0);
    snprintf(line, sizeof(line),
             "ANC fw=%s fs=%d block=%d psram=%u monitor=%s "
             "lvl_primary=%.1f lvl_reference=%.1f lvl_cleaned=%.1f lvl_ai=%.1f "
             "speech=%d ratio_db=%.1f rollbacks=%u guard_trips=%u proc_us_max=%u "
             "ai=%d ai_gain=%.2f ai_us_max=%u out_delay=%d\n",
             FW_VERSION, AUDIO_SAMPLE_RATE, AUDIO_BLOCK_FRAMES,
             (unsigned)esp_psram_get_size(), MON_NAMES[atomic_load(&s_monitor)],
             atomic_load(&s_level_primary_db), atomic_load(&s_level_reference_db),
             atomic_load(&s_level_cleaned_db), atomic_load(&s_level_ai_db),
             (int)atomic_load(&s_speech), atomic_load(&s_ratio_db), atomic_load(&s_rollbacks),
             atomic_load(&s_guard_trips), atomic_load(&s_proc_us_max), (int)s_dn_ok,
             atomic_load(&s_ai_gain), atomic_load(&s_ai_us_max), out_delay);
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

static void init_canceller(void)
{
    anc_config_t cfg = ANC_CONFIG_DEFAULT;
    /* Internal RAM: the filter runs every sample, and PSRAM is far slower. */
    void *mem = heap_caps_malloc(anc_canceller_mem_size(&cfg), MALLOC_CAP_INTERNAL | MALLOC_CAP_8BIT);
    ESP_ERROR_CHECK(mem ? ESP_OK : ESP_ERR_NO_MEM);
    anc_canceller_init(&s_anc, &cfg, mem);
    anc_vad_config_t vcfg = ANC_VAD_CONFIG_DEFAULT;
    anc_vad_init(&s_vad, &vcfg);
    ESP_LOGI(TAG, "canceller: %d taps, mu %.2f, rollback %d ms, guard %.0f dB, %u bytes",
             cfg.taps, cfg.mu, cfg.rollback_blocks * 10, cfg.guard_db,
             (unsigned)anc_canceller_mem_size(&cfg));
}

static void init_denoiser(void)
{
    size_t len = (size_t)(denoiser_bin_end - denoiser_bin_start);
    size_t need = anc_denoise_mem_size(denoiser_bin_start, len, AUDIO_BLOCK_FRAMES);
    if (!need) {
        ESP_LOGE(TAG, "denoiser.bin is not a valid export; running without the AI stage");
        return;
    }
    /* The weights are read every 8 ms: internal RAM if it fits, else PSRAM
     * (slower; check ai_us_max in the info line). */
    void *mem = heap_caps_malloc(need, MALLOC_CAP_INTERNAL | MALLOC_CAP_8BIT);
    bool internal = mem != NULL;
    if (!mem) mem = heap_caps_malloc(need, MALLOC_CAP_SPIRAM | MALLOC_CAP_8BIT);
    if (!mem || anc_denoise_init(&s_dn, denoiser_bin_start, len, AUDIO_BLOCK_FRAMES,
                                 AI_FLOOR_DB, mem) != 0) {
        ESP_LOGE(TAG, "denoiser init failed; running without the AI stage");
        return;
    }
    s_dn_ok = true;
    ESP_LOGI(TAG, "denoiser: %d bands, GRU %d, %u bytes in %s RAM, latency %d samples",
             s_dn.bands, s_dn.hidden, (unsigned)need, internal ? "internal" : "PSRAM",
             anc_denoise_latency(&s_dn));
}

static void start_stream(stream_t which)
{
    atomic_store(&s_stream, which);
    host_link_set_streaming(true);
    apply_amp_state();
    ESP_LOGI(TAG, "recording started (%s)", which == STREAM_CLEANED ? "primary+output" : "primary+reference");
}

void app_main(void)
{
    ESP_LOGI(TAG, "ANC unit firmware %s", FW_VERSION);
    init_canceller();
    init_denoiser();
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
            start_stream(STREAM_MICS);
            break;
        case LINK_CMD_START_CLEANED:
            start_stream(STREAM_CLEANED);
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
            ESP_LOGI(TAG, "speaker: %s", MON_NAMES[atomic_load(&s_monitor)]);
        }

        vTaskDelay(pdMS_TO_TICKS(10));
    }
}
