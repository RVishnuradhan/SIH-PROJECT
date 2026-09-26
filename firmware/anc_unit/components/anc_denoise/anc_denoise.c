#include "anc_denoise.h"

#include <math.h>
#include <stdbool.h>
#include <string.h>

#define BLOB_VERSION 2
#define PI_F 3.14159265358979f

/* ---- Blob parsing --------------------------------------------------------
 * One walk over the blob serves both mem_size (counting) and init (copying
 * into the caller's memory), so the two can never disagree. */

typedef struct {
    const uint8_t *p;
    size_t left;
    uint8_t *dst;          /* NULL while only counting */
    size_t used;
    bool ok;
} walker_t;

static uint32_t rd_u32(walker_t *w)
{
    uint32_t v = 0;
    if (w->left < 4) {
        w->ok = false;
        return 0;
    }
    for (int i = 0; i < 4; i++) v |= (uint32_t)w->p[i] << (8 * i);   /* little-endian */
    w->p += 4;
    w->left -= 4;
    return v;
}

/* Reserve `bytes` (rounded up to 4) of caller memory. */
static float rd_f32(walker_t *w)
{
    uint32_t bits = rd_u32(w);
    float v;
    memcpy(&v, &bits, sizeof(v));
    return v;
}

static void *reserve(walker_t *w, size_t bytes)
{
    void *at = w->dst ? w->dst + w->used : NULL;
    w->used += (bytes + 3) & ~(size_t)3;
    return at;
}

/* Copy `bytes` from the blob into caller memory; the blob keeps 4-byte padding. */
static const void *copy(walker_t *w, size_t bytes)
{
    size_t padded = (bytes + 3) & ~(size_t)3;
    if (w->left < padded) {
        w->ok = false;
        return NULL;
    }
    void *at = reserve(w, bytes);
    if (at) memcpy(at, w->p, bytes);
    w->p += padded;
    w->left -= padded;
    return at;
}

static void read_layer(walker_t *w, anc_dn_layer_t *L, int rows, int cols)
{
    L->rows = (int)rd_u32(w);
    L->cols = (int)rd_u32(w);
    if (L->rows != rows || L->cols != cols) {
        w->ok = false;
        return;
    }
    L->scale = copy(w, sizeof(float) * rows);
    L->bias = copy(w, sizeof(float) * rows);
    L->w = copy(w, (size_t)rows * cols);
}

static int fifo_prefill(int block)
{
    /* Output samples that must be banked before the first block so that
     * every call has `block` finished samples ready: the worst remainder of
     * block * t modulo the hop, which is hop - gcd(block, hop). */
    int a = block, b = ANC_DN_HOP;
    while (b) {
        int t = a % b;
        a = b;
        b = t;
    }
    return block % ANC_DN_HOP == 0 ? 0 : ANC_DN_HOP - a;
}

static bool walk(walker_t *w, anc_denoise_t *d, int block)
{
    if (w->left < 4 || memcmp(w->p, "ANCD", 4) != 0) return false;
    w->p += 4;
    w->left -= 4;
    uint32_t version = rd_u32(w);
    d->bands = (int)rd_u32(w);
    d->dense = (int)rd_u32(w);
    d->hidden = (int)rd_u32(w);
    uint32_t bins = rd_u32(w);
    if (!w->ok || version != BLOB_VERSION || bins != ANC_DN_BINS || d->bands <= 0 ||
        d->bands > 64 || d->dense <= 0 || d->dense > 512 || d->hidden <= 0 || d->hidden > 512 ||
        block <= 0) {
        return false;
    }
    const int B = d->bands, D = d->dense, H = d->hidden;
    d->hp_b0 = rd_f32(w);
    d->hp_b1 = rd_f32(w);
    d->hp_a1 = rd_f32(w);
    d->in_mean = copy(w, sizeof(float) * B);
    d->in_std = copy(w, sizeof(float) * B);
    d->band_matrix = copy(w, sizeof(float) * B * ANC_DN_BINS);
    read_layer(w, &d->inp, D, B);
    read_layer(w, &d->gru1_ih, 3 * H, D);
    read_layer(w, &d->gru1_hh, 3 * H, H);
    read_layer(w, &d->gru2_ih, 3 * H, H);
    read_layer(w, &d->gru2_hh, 3 * H, H);
    read_layer(w, &d->out, B, H);
    if (!w->ok || w->left != 0) return false;

    d->h1 = reserve(w, sizeof(float) * H);
    d->h2 = reserve(w, sizeof(float) * H);
    d->scratch = reserve(w, sizeof(float) * (B + D + 6 * H + ANC_DN_BINS));
    d->gains = reserve(w, sizeof(float) * B);
    d->fifo_in = reserve(w, sizeof(float) * ANC_DN_HOP);
    d->fifo_out = reserve(w, sizeof(float) * (block + 2 * ANC_DN_HOP));
    return true;
}

size_t anc_denoise_mem_size(const void *blob, size_t len, int block)
{
    anc_denoise_t tmp;
    walker_t w = {.p = blob, .left = len, .ok = true};
    return walk(&w, &tmp, block) ? w.used : 0;
}

int anc_denoise_init(anc_denoise_t *d, const void *blob, size_t len, int block,
                     float floor_db, void *mem)
{
    memset(d, 0, sizeof(*d));
    walker_t w = {.p = blob, .left = len, .dst = mem, .ok = true};
    if (!walk(&w, d, block)) return -1;
    memset(d->h1, 0, sizeof(float) * d->hidden);
    memset(d->h2, 0, sizeof(float) * d->hidden);
    for (int b = 0; b < d->bands; b++) d->gains[b] = 1.0f;

    d->floor_gain = powf(10.0f, floor_db / 20.0f);
    for (int i = 0; i < ANC_DN_FRAME; i++) {
        /* sqrt of the periodic Hann window, as anc.postfilter._WIN */
        d->win[i] = sqrtf(0.5f - 0.5f * cosf(2.0f * PI_F * i / ANC_DN_FRAME));
        int r = 0;
        for (int bit = 1, j = i; bit < ANC_DN_FRAME; bit <<= 1, j >>= 1) r = (r << 1) | (j & 1);
        d->bitrev[i] = (uint8_t)r;
    }
    for (int k = 0; k < ANC_DN_FRAME / 2; k++) {
        d->cos_tab[k] = cosf(2.0f * PI_F * k / ANC_DN_FRAME);
        d->sin_tab[k] = sinf(2.0f * PI_F * k / ANC_DN_FRAME);
    }
    d->block = block;
    d->n_out = fifo_prefill(block);   /* banked silence; fifo_out is zeroed below */
    memset(d->fifo_out, 0, sizeof(float) * (block + 2 * ANC_DN_HOP));
    return 0;
}

/* ---- Maths ---------------------------------------------------------------- */

/* In-place radix-2 FFT of ANC_DN_FRAME points; unscaled in both directions. */
static void fft(const anc_denoise_t *d, float *re, float *im, bool inverse)
{
    const int n = ANC_DN_FRAME;
    for (int i = 0; i < n; i++) {
        int j = d->bitrev[i];
        if (j > i) {
            float t = re[i]; re[i] = re[j]; re[j] = t;
            t = im[i]; im[i] = im[j]; im[j] = t;
        }
    }
    for (int len = 2; len <= n; len <<= 1) {
        const int half = len >> 1, step = n / len;
        for (int i = 0; i < n; i += len) {
            for (int k = 0; k < half; k++) {
                float wr = d->cos_tab[k * step];
                float wi = inverse ? d->sin_tab[k * step] : -d->sin_tab[k * step];
                int a = i + k, b = a + half;
                float tr = re[b] * wr - im[b] * wi;
                float ti = re[b] * wi + im[b] * wr;
                re[b] = re[a] - tr;
                im[b] = im[a] - ti;
                re[a] += tr;
                im[a] += ti;
            }
        }
    }
}

static void linear(const anc_dn_layer_t *L, const float *x, float *y)
{
    for (int r = 0; r < L->rows; r++) {
        const int8_t *w = L->w + (size_t)r * L->cols;
        /* Four running sums, so each multiply-add need not wait for the
         * previous one to finish (the FPU is pipelined). */
        float a0 = 0.0f, a1 = 0.0f, a2 = 0.0f, a3 = 0.0f;
        int c = 0;
        for (; c + 4 <= L->cols; c += 4) {
            a0 += (float)w[c] * x[c];
            a1 += (float)w[c + 1] * x[c + 1];
            a2 += (float)w[c + 2] * x[c + 2];
            a3 += (float)w[c + 3] * x[c + 3];
        }
        for (; c < L->cols; c++) a0 += (float)w[c] * x[c];
        y[r] = L->bias[r] + L->scale[r] * ((a0 + a1) + (a2 + a3));
    }
}

static float sigmoid(float x)
{
    return 1.0f / (1.0f + expf(-x));
}

/* PyTorch GRU cell, gate order r, z, n. */
static void gru(const anc_dn_layer_t *ih, const anc_dn_layer_t *hh, const float *x, float *h,
                int H, float *gi, float *gh)
{
    linear(ih, x, gi);
    linear(hh, h, gh);
    for (int j = 0; j < H; j++) {
        float r = sigmoid(gi[j] + gh[j]);
        float z = sigmoid(gi[H + j] + gh[H + j]);
        float n = tanhf(gi[2 * H + j] + r * gh[2 * H + j]);
        h[j] = (1.0f - z) * n + z * h[j];
    }
}

/* ---- Processing ----------------------------------------------------------- */

void anc_denoise_hop(anc_denoise_t *d, const float *in, float *out)
{
    const int B = d->bands, D = d->dense, H = d->hidden, N = ANC_DN_FRAME;
    float *feat = d->scratch, *dense = feat + B, *gi = dense + D, *gh = gi + 3 * H;
    float *power = gh + 3 * H;
    float *re = d->re, *im = d->im;

    memmove(d->frame, d->frame + ANC_DN_HOP, sizeof(float) * (N - ANC_DN_HOP));
    float *fresh = d->frame + N - ANC_DN_HOP;
    for (int i = 0; i < ANC_DN_HOP; i++) {
        /* 60 Hz high-pass, transposed direct form (as scipy's sosfilt) */
        float y = d->hp_b0 * in[i] + d->hp_z;
        d->hp_z = d->hp_b1 * in[i] - d->hp_a1 * y;
        fresh[i] = y;
    }
    for (int i = 0; i < N; i++) {
        re[i] = d->frame[i] * d->win[i];
        im[i] = 0.0f;
    }
    fft(d, re, im, false);

    /* Features: log10 energy per band, normalised as in training. */
    for (int k = 0; k < ANC_DN_BINS; k++) power[k] = re[k] * re[k] + im[k] * im[k];
    for (int b = 0; b < B; b++) {
        const float *row = d->band_matrix + b * ANC_DN_BINS;
        float e = 0.0f;
        for (int k = 0; k < ANC_DN_BINS; k++) e += row[k] * power[k];
        feat[b] = (log10f(e + 1e-10f) - d->in_mean[b]) / d->in_std[b];
    }

    linear(&d->inp, feat, dense);
    for (int j = 0; j < D; j++) dense[j] = tanhf(dense[j]);
    gru(&d->gru1_ih, &d->gru1_hh, dense, d->h1, H, gi, gh);
    gru(&d->gru2_ih, &d->gru2_hh, d->h1, d->h2, H, gi, gh);
    linear(&d->out, d->h2, d->gains);
    for (int b = 0; b < B; b++) d->gains[b] = sigmoid(d->gains[b]);

    /* Band gains -> bin gains, then rebuild the full spectrum of a real signal. */
    for (int k = 0; k < ANC_DN_BINS; k++) {
        float g = 0.0f;
        for (int b = 0; b < B; b++) g += d->gains[b] * d->band_matrix[b * ANC_DN_BINS + k];
        if (g < d->floor_gain) g = d->floor_gain;
        re[k] *= g;
        im[k] *= g;
    }
    im[0] = im[N / 2] = 0.0f;
    for (int k = 1; k < N / 2; k++) {
        re[N - k] = re[k];
        im[N - k] = -im[k];
    }
    fft(d, re, im, true);

    for (int i = 0; i < ANC_DN_HOP; i++) {
        out[i] = d->overlap[i] + re[i] * d->win[i] * (1.0f / N);
        d->overlap[i] = re[ANC_DN_HOP + i] * d->win[ANC_DN_HOP + i] * (1.0f / N);
    }
}

void anc_denoise_process(anc_denoise_t *d, const float *in, float *out)
{
    for (int k = 0; k < d->block;) {
        int take = ANC_DN_HOP - d->n_in;
        if (take > d->block - k) take = d->block - k;
        memcpy(d->fifo_in + d->n_in, in + k, sizeof(float) * take);
        d->n_in += take;
        k += take;
        if (d->n_in == ANC_DN_HOP) {
            anc_denoise_hop(d, d->fifo_in, d->fifo_out + d->n_out);
            d->n_out += ANC_DN_HOP;
            d->n_in = 0;
        }
    }
    memcpy(out, d->fifo_out, sizeof(float) * d->block);
    d->n_out -= d->block;
    memmove(d->fifo_out, d->fifo_out + d->block, sizeof(float) * d->n_out);
}

int anc_denoise_latency(const anc_denoise_t *d)
{
    return ANC_DN_HOP + fifo_prefill(d->block);
}

float anc_denoise_mean_gain(const anc_denoise_t *d)
{
    float s = 0.0f;
    for (int b = 0; b < d->bands; b++) s += d->gains[b];
    return s / d->bands;
}
