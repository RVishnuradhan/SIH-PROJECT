#pragma once
/*
 * Speaker level: what the MAX98357A gets, whichever signal it plays.
 *
 * Firmware up to 0.6.1 multiplied by a fixed 8 (+18 dB). With the voice 2-3 cm
 * from mic 1, or gunfire next to the unit, that clipped 5-19% of the samples
 * in the team's recordings, and the speaker sounded blurred. Now:
 *   - a 20 Hz DC blocker (the raw mics carry a DC offset that ate headroom),
 *   - up to gain_max for quiet sound,
 *   - never above `ceiling`: the gain drops at once on a loud sample and
 *     recovers over `release_s`, so nothing is ever clipped.
 *
 * Header-only and free of ESP-IDF, so tests/test_speaker_level.py can build it.
 */
#include <math.h>

typedef struct {
    float gain_max, ceiling, release, dc_a;
    float dc_x, dc_y, env;
} speaker_level_t;

static inline void speaker_level_init(speaker_level_t *s, float gain_max, float ceiling,
                                      float release_s, float fs)
{
    s->gain_max = gain_max;
    s->ceiling = ceiling;
    s->release = expf(-1.0f / (release_s * fs));
    s->dc_a = 1.0f - 2.0f * 3.14159265f * 20.0f / fs;
    s->dc_x = s->dc_y = s->env = 0.0f;
}

static inline float speaker_level_step(speaker_level_t *s, float x)
{
    float y = x - s->dc_x + s->dc_a * s->dc_y;
    s->dc_x = x;
    s->dc_y = y;
    float a = fabsf(y);
    float decayed = s->env * s->release;
    s->env = a > decayed ? a : decayed;
    float g = s->gain_max;
    if (s->env * g > s->ceiling) {
        g = s->ceiling / s->env;         /* env >= |y|, so |y * g| <= ceiling */
    }
    return y * g;
}
