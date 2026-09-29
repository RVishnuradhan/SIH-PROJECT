#!/usr/bin/env python3
"""Generate synthetic noise files to play through a speaker and re-record on
the ANC unit (see README, "About the training data").

    python tools/make_playback_set.py            # writes data/playback/
    python tools/record.py record --port COM5 --play data/playback/engine_hum_00.wav

Each WAV has a .json sidecar with its labels, which record.py picks up
automatically. Files are 60 s, built from 5 s segments with fresh random
parameters, so one file covers many engines / vehicles / gusts.
"""
from __future__ import annotations

import argparse
import json
from pathlib import Path

import numpy as np
import soundfile as sf

import sys
sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "src"))
from anc import synth  # noqa: E402
from anc.config import SAMPLE_RATE  # noqa: E402

SEGMENT_S = 5.0
FADE_S = 0.05

# name -> (generators mixed together, labels)
RECIPES = {
    "engine_hum":     ((synth.engine_hum,), ["stationary"]),
    "machinery_hum":  ((synth.machinery_hum,), ["stationary"]),
    "engine_rev":     ((synth.engine_rev,), ["non_stationary"]),
    "vehicle_passby": ((synth.vehicle_passby,), ["non_stationary"]),
    "wind_gust":      ((synth.wind_gust,), ["non_stationary"]),
    # Mixed: two noise types audible at once, the multi-label case.
    "engine_and_passby":  ((synth.engine_hum, synth.vehicle_passby), ["stationary", "non_stationary"]),
    "engine_and_impulse": ((synth.engine_hum, synth.impulse_burst), ["stationary", "impulsive"]),
}


def segment(gens, n: int, rng: np.random.Generator) -> np.ndarray:
    # Sources in a mix are kept within 6 dB of each other, so every label on
    # the file is genuinely audible -- a label for an inaudible source is noise.
    x = np.zeros(n, dtype=np.float64)
    for g in gens:
        x += g(n, rng) * 10 ** (rng.uniform(-6, 0) / 20)
    fade = int(FADE_S * SAMPLE_RATE)
    ramp = np.linspace(0, 1, fade)
    x[:fade] *= ramp
    x[-fade:] *= ramp[::-1]
    return x


def make_file(gens, seconds: float, rng: np.random.Generator) -> np.ndarray:
    n_seg = int(round(seconds / SEGMENT_S))
    x = np.concatenate([segment(gens, int(SEGMENT_S * SAMPLE_RATE), rng) for _ in range(n_seg)])
    # RMS at -20 dBFS, peaks limited to -1 dBFS so impulses do not clip the DAC.
    x *= 10 ** (-20 / 20) / (np.sqrt(np.mean(x ** 2)) + 1e-12)
    peak = 10 ** (-1 / 20)
    return np.clip(x, -peak, peak).astype(np.float32)


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--out", type=Path, default=Path("data/playback"))
    ap.add_argument("--files-per-recipe", type=int, default=3)
    ap.add_argument("--seconds", type=float, default=60.0)
    ap.add_argument("--seed", type=int, default=2026)
    args = ap.parse_args()

    args.out.mkdir(parents=True, exist_ok=True)
    total = 0.0
    for r_i, (name, (gens, labels)) in enumerate(RECIPES.items()):
        for k in range(args.files_per_recipe):
            seed = args.seed * 1000 + r_i * 100 + k
            x = make_file(gens, args.seconds, np.random.default_rng(seed))
            stem = args.out / f"{name}_{k:02d}"
            sf.write(stem.with_suffix(".wav"), x, SAMPLE_RATE, subtype="PCM_16")
            stem.with_suffix(".json").write_text(json.dumps(
                {"labels": labels, "recipe": name, "seed": seed, "synthetic": True}, indent=2))
            total += len(x) / SAMPLE_RATE
    print(f"wrote {len(RECIPES) * args.files_per_recipe} files, {total / 60:.0f} min total, to {args.out}/")


if __name__ == "__main__":
    main()
