#!/usr/bin/env python3
"""Measure the project targets: output SNR, STOI, PESQ (and the delay).

    python tools/benchmark_targets.py runs/denoiser_2mic/denoiser.pt --json bench.json

STOI and PESQ compare the output with the original *clean* voice, so they can
only be measured on mixtures where that voice is known; the device cannot
compute them live. Scenes are the two-mic scenes of tools/build_denoise_set.py
built from the held-out split (speakers and noises the network never trained
on): voice at the mouth mic, a faint copy at the outward mic, and noise (DNS
noise, synthetic engines / wind / gunfire-like impulses, the team's recorded
engine noise) reaching both mics differently.

The network is run exactly as the firmware runs it: int8 weights (dequantized),
60 Hz high-pass, two mics, level rule 1.0 with a -25 dB floor.

  output SNR  the same gains applied to the voice and to the noise separately
              (shadow filtering): voice power / left-over noise power
  STOI        pystoi, clean voice vs output (0..1)
  PESQ        wide-band, clean voice vs output (1..4.6)
"""
from __future__ import annotations

import argparse
import importlib.util
import json
import sys
from pathlib import Path

import numpy as np
from pesq import NoUtterancesError, pesq
from pystoi import stoi

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "src"))
from anc.denoiser import dequantized, denoise, highpass, load  # noqa: E402
from anc.postfilter import apply_gains  # noqa: E402

spec = importlib.util.spec_from_file_location("bds", ROOT / "tools/build_denoise_set.py")
bds = importlib.util.module_from_spec(spec)
spec.loader.exec_module(bds)

FS = 16000
TARGETS = {"snr_db": 15.0, "stoi": 0.85, "pesq": 2.5}
RULE_ALPHA = 1.0                                 # as in the firmware
FLOOR_DB, RULE_FLOOR_DB = -30.0, -25.0           # smallest gain of the network / of the level rule
LEVEL_DB = (-45.0, -20.0)                        # mouth-mic level: what the board measured with a close voice, dBFS
LATENCY_MS = 35.0                                # mic to output, measured on the device (out_delay=560)


def db(x):
    return 10 * np.log10(x + 1e-20)


def pesq_wb(ref, deg):
    try:
        return float(pesq(FS, ref.astype(np.float32), deg.astype(np.float32), "wb"))
    except NoUtterancesError:
        return float("nan")


def score_scene(model, s, x1, x2):
    s_hp, n_hp = highpass(s), highpass(x1 - s)
    x_hp = s_hp + n_hp
    y, G = denoise(model, x1, floor_db=FLOOR_DB, ref=x2, rule_alpha=RULE_ALPHA, rule_floor_db=RULE_FLOOR_DB)
    seg = slice(4000, len(s) - 400)                     # skip the filter start-up
    so, no = apply_gains(s_hp, G), apply_gains(n_hp, G)
    return {
        "in_snr_db": db(np.mean(s_hp[seg] ** 2)) - db(np.mean(n_hp[seg] ** 2)),
        "snr_db": db(np.mean(so[seg] ** 2)) - db(np.mean(no[seg] ** 2)),
        "stoi": float(stoi(s_hp[seg], y[seg], FS)),
        "pesq": pesq_wb(s_hp[seg], y[seg]),
        "stoi_in": float(stoi(s_hp[seg], x_hp[seg], FS)),
        "pesq_in": pesq_wb(s_hp[seg], x_hp[seg]),
    }


def noise_type(name):
    """A callable making one source of the named noise type, or None for the mix."""
    if name == "mix":
        return None
    if name == "dns":
        return lambda rng: bds._crop(bds._G["noise"][int(rng.integers(len(bds._G["noise"])))], rng)
    gens = {g.__name__: g for g in bds.SYNTH}
    if name not in gens:
        raise SystemExit(f"unknown noise type {name!r}; choose mix, dns, {', '.join(sorted(gens))}")
    return lambda rng: gens[name](bds.N, rng).astype(np.float64)


def run(model, snrs, n_scenes, noise="mix"):
    clean, noise_files, real = bds.file_lists(ROOT / "data", "val")
    force = noise_type(noise)
    bds._init(clean, noise_files, [] if force else real, mics=2)
    bds._G["force"] = force
    out = {}
    for snr in snrs:
        rows, seed = [], 40_000_000 + 1000 * int(snr + 50)
        while len(rows) < n_scenes:
            seed += 1
            s, x1, x2 = bds.make_scene2(seed, snr_db=snr)
            lvl = 20 * np.log10(bds._rms(x1))
            if bds._rms(s) < 1e-4 or bds._rms(x1 - s) < 1e-6 or not LEVEL_DB[0] < lvl < LEVEL_DB[1]:
                continue                                 # silent voice, no noise, or unrealistic level
            r = score_scene(model, s, x1, x2)
            if not np.isnan(r["pesq"]) and not np.isnan(r["pesq_in"]):
                rows.append(r)
        out[snr] = rows
    return out


def summarize(results):
    table = {}
    for snr, rows in results.items():
        col = lambda k: np.array([r[k] for r in rows])  # noqa: E731
        table[str(snr)] = {
            "scenes": len(rows),
            **{k: float(np.mean(col(k))) for k in ("snr_db", "stoi", "pesq", "stoi_in", "pesq_in")},
            **{f"pass_{k}": float(np.mean(col(k) > t)) for k, t in TARGETS.items()},
            "pass_all": float(np.mean((col("snr_db") > 15) & (col("stoi") > 0.85) & (col("pesq") > 2.5))),
        }
    return table


def main():
    global FLOOR_DB, RULE_FLOOR_DB
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("model", type=Path)
    ap.add_argument("--snrs", type=float, nargs="+", default=[-5, 0, 5, 10, 15])
    ap.add_argument("--n", type=int, default=40, help="scenes per input SNR")
    ap.add_argument("--json", type=Path)
    ap.add_argument("--legacy-noise", action="store_true",
                    help="only the synthetic noise types the first model was trained on (reproduces the README table)")
    ap.add_argument("--noise", default="mix", help="mix (default), dns, or one synthetic type, e.g. impulse_burst")
    ap.add_argument("--floor-db", type=float, default=-30.0, help="smallest gain of the network (firmware: -30)")
    ap.add_argument("--rule-floor-db", type=float, default=-25.0, help="smallest gain of the level rule (firmware: -25)")
    args = ap.parse_args()
    FLOOR_DB, RULE_FLOOR_DB = args.floor_db, args.rule_floor_db
    if args.legacy_noise:
        bds.SYNTH = bds.SYNTH_LEGACY

    model = dequantized(load(args.model))               # what the device runs
    table = summarize(run(model, args.snrs, args.n, args.noise))

    print(f"\nTargets: output SNR > {TARGETS['snr_db']} dB, STOI > {TARGETS['stoi']}, PESQ > {TARGETS['pesq']}"
          f"   (delay {LATENCY_MS:.0f} ms)")
    print(f"{'input SNR':>10} | {'out SNR':>8} | {'STOI':>11} | {'PESQ':>11} | scenes meeting: SNR / STOI / PESQ / all")
    for snr, r in table.items():
        print(f"{float(snr):>7.0f} dB | {r['snr_db']:6.1f}dB | {r['stoi_in']:.2f}->{r['stoi']:.2f} | "
              f"{r['pesq_in']:.2f}->{r['pesq']:.2f} | {r['pass_snr_db']:4.0%} / {r['pass_stoi']:4.0%} / "
              f"{r['pass_pesq']:4.0%} / {r['pass_all']:4.0%}")
    if args.json:
        args.json.write_text(json.dumps({"targets": TARGETS, "latency_ms": LATENCY_MS,
                                         "scenes_per_snr": args.n, "by_input_snr": table}, indent=1))
        print(f"\nwrote {args.json}")


if __name__ == "__main__":
    main()
