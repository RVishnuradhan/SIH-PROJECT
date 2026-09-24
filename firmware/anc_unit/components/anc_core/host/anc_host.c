/*
 * PC harness for anc_core, used by tests/test_c_port.py.
 *
 *   anc_host <n> <primary.f64> <reference.f64> <gate.u8|vad> <out.f64>
 *
 * Inputs are raw little-endian float64. gate.u8 holds one byte per block:
 * 0 = no speech, 1 = speech, 2 = no new decision (keep the previous one),
 * applied before that block is processed -- the same schedule as
 * anc.loop.run(). "vad" instead drives the canceller with the built-in
 * level-ratio detector, fed after each block.
 */
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

#include "anc_core.h"

static double *read_f64(const char *path, long n)
{
    FILE *f = fopen(path, "rb");
    if (!f) { perror(path); exit(2); }
    double *buf = malloc(n * sizeof(double));
    if (fread(buf, sizeof(double), n, f) != (size_t)n) { fprintf(stderr, "%s: short read\n", path); exit(2); }
    fclose(f);
    return buf;
}

int main(int argc, char **argv)
{
    if (argc != 6) {
        fprintf(stderr, "usage: anc_host <n> <primary> <reference> <gate|vad> <out>\n");
        return 2;
    }
    long n = atol(argv[1]);
    double *pri = read_f64(argv[2], n);
    double *ref = read_f64(argv[3], n);
    bool use_vad = strcmp(argv[4], "vad") == 0;

    anc_config_t cfg = ANC_CONFIG_DEFAULT;
    long blocks = n / cfg.block;
    unsigned char *gate = NULL;
    if (!use_vad) {
        gate = malloc(blocks);
        FILE *g = fopen(argv[4], "rb");
        if (!g || fread(gate, 1, blocks, g) != (size_t)blocks) { fprintf(stderr, "bad gate file\n"); return 2; }
        fclose(g);
    }

    anc_canceller_t c;
    void *mem = malloc(anc_canceller_mem_size(&cfg));
    anc_canceller_init(&c, &cfg, mem);
    anc_vad_t vad;
    anc_vad_config_t vcfg = ANC_VAD_CONFIG_DEFAULT;
    anc_vad_init(&vad, &vcfg);

    anc_real_t *bp = malloc(cfg.block * sizeof(anc_real_t));
    anc_real_t *br = malloc(cfg.block * sizeof(anc_real_t));
    anc_real_t *bo = malloc(cfg.block * sizeof(anc_real_t));
    FILE *fo = fopen(argv[5], "wb");
    for (long b = 0; b < blocks; b++) {
        for (int i = 0; i < cfg.block; i++) {
            bp[i] = (anc_real_t)pri[b * cfg.block + i];
            br[i] = (anc_real_t)ref[b * cfg.block + i];
        }
        if (!use_vad && gate[b] != 2) {
            anc_canceller_set_speech(&c, gate[b] == 1);
        }
        anc_canceller_process_block(&c, bp, br, bo);
        if (use_vad && anc_vad_feed(&vad, bp, br, cfg.block)) {
            anc_canceller_set_speech(&c, vad.speech);
        }
        for (int i = 0; i < cfg.block; i++) {
            double v = bo[i];
            fwrite(&v, sizeof(double), 1, fo);
        }
    }
    fclose(fo);
    fprintf(stderr, "rollbacks=%u guard_trips=%u\n", (unsigned)c.rollbacks, (unsigned)c.guard_trips);
    return 0;
}
