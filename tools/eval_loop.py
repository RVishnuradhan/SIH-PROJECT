#!/usr/bin/env python3
"""Closed-loop test: trained speech detector driving the canceller.

    python tools/eval_loop.py runs/synth_2mic/model.pt runs/synth_1mic/model.pt

Prints output SNR per noise type for: no detector, each model, and a perfect
detector, plus how late each model flags the start of a phrase.
"""
from __future__ import annotations

import argparse
import os
import sys
from pathlib import Path

os.environ.setdefault("OPENBLAS_NUM_THREADS", "1")
import numpy as np  # noqa: E402
import torch  # noqa: E402

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "src"))
from anc import synth  # noqa: E402
from anc.loop import (level_ratio_decisions, model_decisions, onset_lags_ms,  # noqa: E402
                      oracle_decisions, phrased_scene, run, score)
from anc.training import load  # noqa: E402

NOISES = {"engine steady": synth.engine_hum, "engine revving": synth.engine_rev,
          "vehicle pass-by": synth.vehicle_passby, "wind": synth.wind_gust,
          "machinery": synth.machinery_hum}


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("models", nargs="+", type=Path)
    ap.add_argument("--scenes", type=int, default=4, help="scenes per noise type")
    ap.add_argument("--threshold", type=float, default=0.5)
    ap.add_argument("--snr", type=float, default=0.0)
    ap.add_argument("--seed-base", type=int, default=5_000_000,
                    help="change this to evaluate on scenes nothing was tuned on")
    a = ap.parse_args()
    torch.set_num_threads(2)

    models = {p.parent.name: load(p) for p in a.models}
    rows = ["no detector", "level ratio (no AI)"] + list(models) + ["perfect detector"]
    table = {r: {} for r in rows}
    lags = {m: [] for m in ["level ratio (no AI)", *models]}
    for ni, (noise, fn) in enumerate(NOISES.items()):
        for s in range(a.scenes):
            sc = phrased_scene(a.seed_base + 100 * ni + s, fn, snr_db_=a.snr)
            table["no detector"].setdefault(noise, []).append(score(sc, run(sc, None)))
            table["perfect detector"].setdefault(noise, []).append(score(sc, run(sc, oracle_decisions(sc))))
            dec = level_ratio_decisions(sc)
            table["level ratio (no AI)"].setdefault(noise, []).append(score(sc, run(sc, dec)))
            lags["level ratio (no AI)"] += onset_lags_ms(sc, dec)
            for name, m in models.items():
                dec = model_decisions(m, sc, a.threshold)
                table[name].setdefault(noise, []).append(score(sc, run(sc, dec)))
                lags[name] += onset_lags_ms(sc, dec)

    print(f"\nOutput SNR (dB), input {a.snr:.0f} dB, {a.scenes} scenes per noise type, threshold {a.threshold}\n")
    print(f"{'':20s}" + "".join(f"{n[:15]:>16s}" for n in NOISES) + f"{'MEAN':>9s}{'WORST':>8s}")
    for r in rows:
        vals = [np.mean(table[r][n]) for n in NOISES]
        allv = np.concatenate([table[r][n] for n in NOISES])
        print(f"{r:20.20s}" + "".join(f"{v:16.1f}" for v in vals) + f"{allv.mean():9.1f}{allv.min():8.1f}")
    print("\nSpeech onset detection delay (ms after the phrase starts):")
    for name, l in lags.items():
        l = np.array(l)
        print(f"  {name:18s} median {np.median(l):5.0f}   90th pct {np.percentile(l, 90):5.0f}   "
              f"({len(l)} onsets detected)")


if __name__ == "__main__":
    main()
