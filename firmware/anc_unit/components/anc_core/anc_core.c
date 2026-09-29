#include "anc_core.h"

#include <math.h>
#include <string.h>

/* ---- Canceller ---------------------------------------------------------- */

size_t anc_canceller_mem_size(const anc_config_t *cfg)
{
    size_t n = (size_t)cfg->taps                         /* w */
             + 2 * (size_t)cfg->taps                     /* xbuf */
             + (size_t)cfg->delay + 1                    /* dline */
             + (size_t)cfg->rollback_blocks * cfg->taps  /* snaps */
             + (size_t)cfg->taps                         /* good_w */
             + (size_t)cfg->block;                       /* dblock */
    return n * sizeof(anc_real_t);
}

void anc_canceller_init(anc_canceller_t *c, const anc_config_t *cfg, void *mem)
{
    memset(c, 0, sizeof(*c));
    c->cfg = *cfg;
    memset(mem, 0, anc_canceller_mem_size(cfg));
    anc_real_t *p = mem;
    c->w = p;       p += cfg->taps;
    c->xbuf = p;    p += 2 * cfg->taps;
    c->dline = p;   p += cfg->delay + 1;
    c->snaps = p;   p += (size_t)cfg->rollback_blocks * cfg->taps;
    c->good_w = p;  p += cfg->taps;
    c->dblock = p;
}

void anc_canceller_set_speech(anc_canceller_t *c, bool speech)
{
    const int rb = c->cfg.rollback_blocks;
    if (speech && !c->speech && c->snap_count >= rb) {
        /* Oldest snapshot in the ring: the weights from rollback_blocks ago. */
        int oldest = (c->snap_head - c->snap_count + rb) % rb;
        memcpy(c->w, c->snaps + (size_t)oldest * c->cfg.taps, c->cfg.taps * sizeof(anc_real_t));
        c->rollbacks++;
    }
    c->speech = speech;
}

static anc_real_t window_energy(const anc_canceller_t *c)
{
    const anc_real_t *x = c->xbuf + c->xpos;
    anc_real_t s = 0;
    for (int k = 0; k < c->cfg.taps; k++) {
        s += x[k] * x[k];
    }
    return s;
}

void anc_canceller_process_block(anc_canceller_t *c, const anc_real_t *primary,
                                 const anc_real_t *reference, anc_real_t *out)
{
    const anc_config_t *cfg = &c->cfg;
    const int taps = cfg->taps;
    const int dlen = cfg->delay + 1;
    const anc_real_t mu = c->speech ? 0 : cfg->mu;
    const bool update = (mu != 0) || (cfg->leak != 1);

    /* Exact recompute once per block, then O(1) running updates per sample.
     * Keeps float32 rounding drift from accumulating on the device. */
    c->x_energy = window_energy(c);

    double e_in = 0, e_out = 0;
    for (int i = 0; i < cfg->block; i++) {
        /* Reference history: newest first, contiguous at xbuf[xpos]. */
        c->xpos = (c->xpos == 0 ? taps : c->xpos) - 1;
        anc_real_t oldest = c->xbuf[c->xpos];
        c->xbuf[c->xpos] = reference[i];
        c->xbuf[c->xpos + taps] = reference[i];
        c->x_energy += reference[i] * reference[i] - oldest * oldest;
        if (c->x_energy < 0) {
            c->x_energy = window_energy(c);
        }
        const anc_real_t *x = c->xbuf + c->xpos;

        /* Primary delayed by cfg->delay samples. */
        c->dline[c->dpos] = primary[i];
        c->dpos = (c->dpos + 1) % dlen;
        anc_real_t d = c->dline[c->dpos];
        c->dblock[i] = d;

        anc_real_t y = 0;
        for (int k = 0; k < taps; k++) {
            y += c->w[k] * x[k];
        }
        anc_real_t e = d - y;
        out[i] = e;

        if (update) {
            anc_real_t g = mu * e / (c->x_energy + cfg->eps);
            for (int k = 0; k < taps; k++) {
                c->w[k] = c->w[k] * cfg->leak + g * x[k];
            }
        }
        e_in += (double)d * d;
        e_out += (double)e * e;
    }

    /* Divergence guard: never output a block much louder than its input. */
    double ratio_db = 10.0 * log10(e_out / (e_in + 1e-20) + 1e-20);
    if (cfg->guard_db > 0 && ratio_db > cfg->guard_db) {
        c->guard_trips++;
        memcpy(out, c->dblock, cfg->block * sizeof(anc_real_t));   /* bypass */
        if (c->tripped_last) {
            memset(c->good_w, 0, taps * sizeof(anc_real_t));        /* good weights are stale too */
        }
        memcpy(c->w, c->good_w, taps * sizeof(anc_real_t));        /* restart, keep adapting */
        c->tripped_last = true;
    } else {
        c->tripped_last = false;
        if (!c->speech && ratio_db < -cfg->good_db) {
            memcpy(c->good_w, c->w, taps * sizeof(anc_real_t));
        }
    }

    /* Rollback ring. */
    const int rb = cfg->rollback_blocks;
    memcpy(c->snaps + (size_t)c->snap_head * taps, c->w, taps * sizeof(anc_real_t));
    c->snap_head = (c->snap_head + 1) % rb;
    if (c->snap_count < rb) {
        c->snap_count++;
    }
}

/* ---- Level-ratio detector ----------------------------------------------- */

void anc_vad_init(anc_vad_t *v, const anc_vad_config_t *cfg)
{
    memset(v, 0, sizeof(*v));
    v->cfg = *cfg;
    if (v->cfg.window_blocks > ANC_VAD_MAX_WINDOW) {
        v->cfg.window_blocks = ANC_VAD_MAX_WINDOW;
    }
    v->decisions_since_positive = 1 << 20;   /* "long ago" */
}

bool anc_vad_feed(anc_vad_t *v, const anc_real_t *primary, const anc_real_t *reference, int n)
{
    double ep = 0, er = 0;
    for (int i = 0; i < n; i++) {
        ep += (double)primary[i] * primary[i];
        er += (double)reference[i] * reference[i];
    }
    v->ep[v->head] = ep;
    v->er[v->head] = er;
    v->head = (v->head + 1) % v->cfg.window_blocks;
    if (v->filled < v->cfg.window_blocks) {
        v->filled++;
    }
    if (++v->blocks_since_decision < v->cfg.period_blocks || v->filled < v->cfg.window_blocks) {
        return false;
    }
    v->blocks_since_decision = 0;

    double sp = 0, sr = 0;
    for (int k = 0; k < v->cfg.window_blocks; k++) {
        sp += v->ep[k];
        sr += v->er[k];
    }
    v->last_ratio_db = (anc_real_t)(10.0 * log10((sp + 1e-20) / (sr + 1e-20)));
    if (v->last_ratio_db > v->cfg.threshold_db) {
        v->decisions_since_positive = 0;
    } else if (v->decisions_since_positive < (1 << 20)) {
        v->decisions_since_positive++;
    }
    v->speech = v->decisions_since_positive <= v->cfg.hold_decisions;
    return true;
}
