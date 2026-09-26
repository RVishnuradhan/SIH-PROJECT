#pragma once
/*
 * Noise canceller core: plain C, no ESP-IDF dependencies.
 *
 * C port of src/anc/nlms.py (NlmsCanceller + GatedCanceller) and of
 * level_ratio_decisions() in src/anc/loop.py. It builds unchanged for the
 * ESP32 and for a PC, so tests/test_c_port.py can check it sample-for-sample
 * against the Python reference. Change the two together.
 *
 * Memory is supplied by the caller (see *_mem_size), so the firmware can put
 * it in internal RAM and nothing here calls malloc.
 */
#include <stdbool.h>
#include <stddef.h>
#include <stdint.h>

/* float on the ESP32. The PC test builds with -DANC_REAL=double to compare
 * exactly against the Python reference, which computes in double. */
#ifndef ANC_REAL
#define ANC_REAL float
#endif
typedef ANC_REAL anc_real_t;

/* ---- Canceller ---------------------------------------------------------- */

typedef struct {
    int taps;              /* adaptive filter length (128 = 8 ms at 16 kHz) */
    anc_real_t mu;         /* step size while no speech */
    int delay;             /* primary delay in samples (lets the causal filter
                              cancel noise that reaches the primary first) */
    anc_real_t eps;        /* keeps the NLMS normalisation finite in silence */
    anc_real_t leak;       /* 1 = no leakage */
    int block;             /* samples per block (160 = 10 ms) */
    int rollback_blocks;   /* weights restored from this many blocks ago on speech onset */
    anc_real_t guard_db;   /* bypass a block whose output exceeds its input by this; <= 0 disables */
    anc_real_t good_db;    /* a no-speech block this much quieter than its input marks good weights */
} anc_config_t;

#define ANC_CONFIG_DEFAULT \
    { .taps = 128, .mu = 0.1, .delay = 16, .eps = 1e-6, .leak = 1.0, \
      .block = 160, .rollback_blocks = 15, .guard_db = 6.0, .good_db = 3.0 }

typedef struct {
    anc_config_t cfg;
    anc_real_t *w;          /* filter weights */
    anc_real_t *xbuf;       /* reference history, stored twice so the newest-first
                               window is always contiguous: xbuf[xpos .. xpos+taps) */
    anc_real_t *dline;      /* primary delay line (delay + 1) */
    anc_real_t *snaps;      /* rollback ring: rollback_blocks x taps */
    anc_real_t *good_w;     /* last known-good weights */
    anc_real_t *dblock;     /* delayed primary for the current block (guard reference) */
    int xpos, dpos, snap_head, snap_count;
    anc_real_t x_energy;
    bool speech, tripped_last;
    uint32_t rollbacks, guard_trips;
} anc_canceller_t;

size_t anc_canceller_mem_size(const anc_config_t *cfg);
void anc_canceller_init(anc_canceller_t *c, const anc_config_t *cfg, void *mem);

/* Apply a speech decision; takes effect from the next block. On a
 * no-speech -> speech transition the weights roll back. */
void anc_canceller_set_speech(anc_canceller_t *c, bool speech);

/* Process one block of cfg.block samples. `out` may not alias the inputs. */
void anc_canceller_process_block(anc_canceller_t *c, const anc_real_t *primary,
                                 const anc_real_t *reference, anc_real_t *out);

/* ---- Level-ratio speech detector (the non-AI baseline) ----------------- */

typedef struct {
    int window_blocks;      /* energy window (5 = 50 ms) */
    int period_blocks;      /* decide every N blocks (5 = 50 ms) */
    int hold_decisions;     /* keep saying speech this many decisions after the last positive */
    anc_real_t threshold_db;
} anc_vad_config_t;

#define ANC_VAD_CONFIG_DEFAULT \
    { .window_blocks = 5, .period_blocks = 5, .hold_decisions = 3, .threshold_db = 1.5 }

#define ANC_VAD_MAX_WINDOW 32

typedef struct {
    anc_vad_config_t cfg;
    double ep[ANC_VAD_MAX_WINDOW], er[ANC_VAD_MAX_WINDOW];
    int head, filled, blocks_since_decision, decisions_since_positive;
    bool speech;
    anc_real_t last_ratio_db;
} anc_vad_t;

void anc_vad_init(anc_vad_t *v, const anc_vad_config_t *cfg);

/* Feed one block of raw mic samples. Returns true when a new decision was
 * made this block; the decision is then in v->speech. */
bool anc_vad_feed(anc_vad_t *v, const anc_real_t *primary, const anc_real_t *reference, int n);
