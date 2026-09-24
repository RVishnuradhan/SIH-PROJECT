#pragma once

#include <stdbool.h>
#include <stddef.h>
#include <stdint.h>

#include "esp_err.h"

/* Sets up both I2S buses and starts them. The amp starts shut down. */
esp_err_t audio_io_init(void);

/*
 * Blocks until `frames` stereo mic frames are available (frames must not
 * exceed AUDIO_BLOCK_FRAMES). Outputs are 24-bit samples, sign-extended into
 * int32. Primary and reference are captured on the same clock edge.
 */
esp_err_t audio_io_read(int32_t *primary, int32_t *reference, size_t frames);

/* Writes one mono block to the amp (duplicated into both I2S slots). */
esp_err_t audio_io_write_mono(const int16_t *samples, size_t frames);

/* Drives the MAX98357A SD pin. Off = shutdown, no output at all. */
void audio_io_amp_enable(bool on);
