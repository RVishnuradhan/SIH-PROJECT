/*
 * PC harness for anc_denoise, used by tests/test_denoiser_c.py.
 *
 *   denoise_host <weights.bin> <block> <n> <in.f32> <out.f32>
 *
 * Runs n samples (a multiple of block) through anc_denoise_process and
 * prints "latency=<samples> mem=<bytes>" on stdout.
 */
#include <stdio.h>
#include <stdlib.h>

#include "anc_denoise.h"

static void *slurp(const char *path, size_t *len)
{
    FILE *f = fopen(path, "rb");
    if (!f) { perror(path); exit(2); }
    fseek(f, 0, SEEK_END);
    *len = (size_t)ftell(f);
    fseek(f, 0, SEEK_SET);
    void *buf = malloc(*len);
    if (fread(buf, 1, *len, f) != *len) { fprintf(stderr, "%s: short read\n", path); exit(2); }
    fclose(f);
    return buf;
}

int main(int argc, char **argv)
{
    if (argc != 6) {
        fprintf(stderr, "usage: denoise_host <weights.bin> <block> <n> <in.f32> <out.f32>\n");
        return 2;
    }
    size_t blob_len, in_len;
    void *blob = slurp(argv[1], &blob_len);
    int block = atoi(argv[2]);
    long n = atol(argv[3]);
    float *in = slurp(argv[4], &in_len);
    if (in_len != (size_t)n * sizeof(float) || n % block) { fprintf(stderr, "bad input length\n"); return 2; }

    size_t mem_len = anc_denoise_mem_size(blob, blob_len, block);
    if (!mem_len) { fprintf(stderr, "invalid weights blob\n"); return 3; }
    anc_denoise_t *d = malloc(sizeof(*d));
    void *mem = malloc(mem_len);
    if (anc_denoise_init(d, blob, blob_len, block, -30.0f, mem) != 0) { fprintf(stderr, "init failed\n"); return 3; }

    float *out = malloc(n * sizeof(float));
    for (long k = 0; k < n; k += block) anc_denoise_process(d, in + k, out + k);

    FILE *f = fopen(argv[5], "wb");
    fwrite(out, sizeof(float), n, f);
    fclose(f);
    printf("latency=%d mem=%zu\n", anc_denoise_latency(d), mem_len);
    return 0;
}
