#pragma once

/* Mirrors src/anc/config.py. The Python pipeline and the firmware must agree
 * on these or features computed on the device will not match training. */
#define AUDIO_SAMPLE_RATE   16000
#define AUDIO_BLOCK_FRAMES  160      /* 10 ms, equal to HOP_LENGTH */

/* INMP441 samples are 24-bit, so full scale is 2^23. */
#define AUDIO_FULL_SCALE_24 8388608.0f
