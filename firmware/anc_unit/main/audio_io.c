#include "audio_io.h"

#include <assert.h>
#include <string.h>

#include "audio_config.h"
#include "board.h"
#include "driver/gpio.h"
#include "driver/i2s_std.h"
#include "esp_check.h"
#include "freertos/FreeRTOS.h"

static const char *TAG = "audio_io";

static i2s_chan_handle_t s_rx;
static i2s_chan_handle_t s_tx;
static int32_t s_rx_buf[AUDIO_BLOCK_FRAMES * 2];
static int16_t s_tx_buf[AUDIO_BLOCK_FRAMES * 2];

static esp_err_t init_mics(void)
{
    i2s_chan_config_t chan = I2S_CHANNEL_DEFAULT_CONFIG(I2S_NUM_0, I2S_ROLE_MASTER);
    chan.dma_desc_num = 6;
    chan.dma_frame_num = AUDIO_BLOCK_FRAMES;
    ESP_RETURN_ON_ERROR(i2s_new_channel(&chan, NULL, &s_rx), TAG, "mic channel");

    /* The INMP441 expects 64 BCLKs per frame (32 per slot) and puts its 24-bit
     * sample MSB-first at the top of each 32-bit slot. Both mics share one data
     * line and each drives only its own slot, so a single stereo frame holds
     * primary and reference sampled at the same instant. The adaptive filter
     * depends on that: any skew between the mics is error it cannot remove. */
    i2s_std_config_t cfg = {
        .clk_cfg = I2S_STD_CLK_DEFAULT_CONFIG(AUDIO_SAMPLE_RATE),
        .slot_cfg = I2S_STD_PHILIPS_SLOT_DEFAULT_CONFIG(I2S_DATA_BIT_WIDTH_32BIT,
                                                        I2S_SLOT_MODE_STEREO),
        .gpio_cfg = {
            .mclk = I2S_GPIO_UNUSED,
            .bclk = PIN_MIC_BCLK,
            .ws = PIN_MIC_WS,
            .dout = I2S_GPIO_UNUSED,
            .din = PIN_MIC_DATA,
        },
    };
    ESP_RETURN_ON_ERROR(i2s_channel_init_std_mode(s_rx, &cfg), TAG, "mic std mode");
    return i2s_channel_enable(s_rx);
}

static esp_err_t init_amp(void)
{
    i2s_chan_config_t chan = I2S_CHANNEL_DEFAULT_CONFIG(I2S_NUM_1, I2S_ROLE_MASTER);
    chan.dma_desc_num = 6;
    chan.dma_frame_num = AUDIO_BLOCK_FRAMES;
    /* On underrun, play silence rather than looping the last block. */
    chan.auto_clear = true;
    ESP_RETURN_ON_ERROR(i2s_new_channel(&chan, &s_tx, NULL), TAG, "amp channel");

    i2s_std_config_t cfg = {
        .clk_cfg = I2S_STD_CLK_DEFAULT_CONFIG(AUDIO_SAMPLE_RATE),
        .slot_cfg = I2S_STD_PHILIPS_SLOT_DEFAULT_CONFIG(I2S_DATA_BIT_WIDTH_16BIT,
                                                        I2S_SLOT_MODE_STEREO),
        .gpio_cfg = {
            .mclk = I2S_GPIO_UNUSED,
            .bclk = PIN_AMP_BCLK,
            .ws = PIN_AMP_LRC,
            .dout = PIN_AMP_DIN,
            .din = I2S_GPIO_UNUSED,
        },
    };
    ESP_RETURN_ON_ERROR(i2s_channel_init_std_mode(s_tx, &cfg), TAG, "amp std mode");

    /* Preload silence so the first real block does not underrun. */
    memset(s_tx_buf, 0, sizeof(s_tx_buf));
    size_t loaded = 0;
    ESP_RETURN_ON_ERROR(i2s_channel_preload_data(s_tx, s_tx_buf, sizeof(s_tx_buf), &loaded),
                        TAG, "amp preload");
    return i2s_channel_enable(s_tx);
}

esp_err_t audio_io_init(void)
{
    gpio_config_t sd = {
        .pin_bit_mask = 1ULL << PIN_AMP_SD,
        .mode = GPIO_MODE_OUTPUT,
    };
    ESP_RETURN_ON_ERROR(gpio_config(&sd), TAG, "amp SD pin");
    audio_io_amp_enable(false);

    ESP_RETURN_ON_ERROR(init_mics(), TAG, "mics");
    ESP_RETURN_ON_ERROR(init_amp(), TAG, "amp");
    return ESP_OK;
}

esp_err_t audio_io_read(int32_t *primary, int32_t *reference, size_t frames)
{
    assert(frames <= AUDIO_BLOCK_FRAMES);
    const size_t want = frames * 2 * sizeof(int32_t);
    size_t got = 0;
    ESP_RETURN_ON_ERROR(i2s_channel_read(s_rx, s_rx_buf, want, &got, portMAX_DELAY),
                        TAG, "mic read");
    if (got != want) {
        return ESP_ERR_INVALID_SIZE;
    }
    for (size_t i = 0; i < frames; i++) {
        /* Arithmetic shift keeps the sign: top 24 bits of the slot. */
        primary[i] = s_rx_buf[2 * i] >> 8;
        reference[i] = s_rx_buf[2 * i + 1] >> 8;
    }
    return ESP_OK;
}

esp_err_t audio_io_write_mono(const int16_t *samples, size_t frames)
{
    assert(frames <= AUDIO_BLOCK_FRAMES);
    /* Same sample in both slots, so the output is right whichever channel
     * the MAX98357A's SD_MODE level selects. */
    for (size_t i = 0; i < frames; i++) {
        s_tx_buf[2 * i] = samples[i];
        s_tx_buf[2 * i + 1] = samples[i];
    }
    size_t written = 0;
    return i2s_channel_write(s_tx, s_tx_buf, frames * 2 * sizeof(int16_t), &written,
                             portMAX_DELAY);
}

void audio_io_amp_enable(bool on)
{
    gpio_set_level(PIN_AMP_SD, on ? 1 : 0);
}
