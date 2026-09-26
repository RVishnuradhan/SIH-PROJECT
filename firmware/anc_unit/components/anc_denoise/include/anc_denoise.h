#pragma once
/*
 * Neural noise suppressor: plain C, no ESP-IDF dependencies.
 *
 * C port of anc.denoiser (Python). Every 8 ms (128 samples):
 *   60 Hz high-pass -> 256-sample frame, sqrt-Hann -> FFT -> log energy in 24 bands
 *   -> Dense 64 (tanh) -> GRU 96 -> GRU 96 -> Dense 24 (sigmoid)
 *   -> 24 band gains spread over 129 FFT bins -> inverse FFT -> overlap-add.
 *
 * The weights come from tools/export_denoiser.py as one blob (int8 weights
 * with a float scale per row). tests/test_denoiser_c.py checks this code
 * against the Python network sample for sample.
 *
 * Memory is supplied by the caller (see anc_denoise_mem_size); init copies
 * the weights into it, so the firmware can keep them in internal RAM.
 */
#include <stddef.h>
#include <stdint.h>

#define ANC_DN_FRAME 256
#define ANC_DN_HOP 128
#define ANC_DN_BINS (ANC_DN_FRAME / 2 + 1)

typedef struct {
    int rows, cols;
    const float *scale;     /* [rows] */
    const float *bias;      /* [rows] */
    const int8_t *w;        /* [rows][cols] */
} anc_dn_layer_t;

typedef struct {
    int bands, dense, hidden;
    const float *in_mean, *in_std;   /* [bands] feature normalisation */
    const float *band_matrix;        /* [bands][bins]; columns sum to 1 */
    anc_dn_layer_t inp, gru1_ih, gru1_hh, gru2_ih, gru2_hh, out;

    float hp_b0, hp_b1, hp_a1, hp_z; /* input high-pass and its state */
    float floor_gain;                /* smallest per-bin gain (-30 dB = 0.0316) */
    float *h1, *h2;                  /* GRU states [hidden] */
    float *scratch;                  /* layer outputs */
    float *gains;                    /* last band gains [bands] */
    float frame[ANC_DN_FRAME];       /* newest 256 input samples */
    float overlap[ANC_DN_HOP];       /* second half of the previous output frame */
    float re[ANC_DN_FRAME], im[ANC_DN_FRAME];
    float win[ANC_DN_FRAME];
    float cos_tab[ANC_DN_FRAME / 2], sin_tab[ANC_DN_FRAME / 2];
    uint8_t bitrev[ANC_DN_FRAME];

    /* Block adapter: any block size in, the same size out, fixed latency. */
    int block;
    float *fifo_in, *fifo_out;
    int n_in, n_out;
} anc_denoise_t;

/* Bytes of caller memory needed for this blob and block size, or 0 if the
 * blob is not a valid export. */
size_t anc_denoise_mem_size(const void *blob, size_t len, int block);

/* Returns 0 on success, negative if the blob is invalid. */
int anc_denoise_init(anc_denoise_t *d, const void *blob, size_t len, int block,
                     float floor_db, void *mem);

/* One hop: 128 new samples in, 128 finished samples out, 128 samples late. */
void anc_denoise_hop(anc_denoise_t *d, const float *in, float *out);

/* `block` samples in, `block` out. Output lags input by anc_denoise_latency(). */
void anc_denoise_process(anc_denoise_t *d, const float *in, float *out);

/* Samples between a sample going in and the same sample coming out. */
int anc_denoise_latency(const anc_denoise_t *d);

/* Mean band gain of the last frame: 1 = passed through, near 0 = suppressed. */
float anc_denoise_mean_gain(const anc_denoise_t *d);
