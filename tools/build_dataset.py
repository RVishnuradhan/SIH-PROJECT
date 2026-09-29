#!/usr/bin/env python3
"""Build a training set of feature windows.

Synthetic scenes (available now):
    python tools/build_dataset.py synth --clips 3000 --seed 0    --out data/sets/synth_train.npz
    python tools/build_dataset.py synth --clips 500  --seed 9000 --out data/sets/synth_val.npz

Your recordings (once data/raw/ has files from tools/record.py):
    python tools/build_dataset.py recordings --dir data/raw --out data/sets/real.npz

Use a different --seed range for validation so no scene appears in both.
"""
from __future__ import annotations

import os

# One maths-library thread per process, set before numpy loads. Without this,
# OpenBLAS starts a thread per core in every worker, and 4 workers x 4 threads
# on 4 cores run ~8x slower than one worker from contention.
for _var in ("OMP_NUM_THREADS", "OPENBLAS_NUM_THREADS", "MKL_NUM_THREADS"):
    os.environ.setdefault(_var, "1")

import argparse  # noqa: E402
import sys
import time
import multiprocessing as mp
from pathlib import Path

import numpy as np

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "src"))
from anc.dataset import LABELS, pack, recording_windows, synthetic_clip  # noqa: E402


def summarize(d: dict) -> None:
    L = d["labels"]
    print(f"{len(L)} windows, features {d['features'].shape}")
    for i, name in enumerate(LABELS):
        col = L[:, i]
        known = ~np.isnan(col)
        print(f"  {name:15s} positive {100 * np.mean(col[known] == 1):5.1f}%   masked {100 * np.mean(~known):4.1f}%")


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    sub = ap.add_subparsers(dest="src", required=True)
    s = sub.add_parser("synth")
    s.add_argument("--clips", type=int, default=3000)
    s.add_argument("--seed", type=int, default=0)
    s.add_argument("--workers", type=int, default=4)
    r = sub.add_parser("recordings")
    r.add_argument("--dir", type=Path, default=Path("data/raw"))
    for p in (s, r):
        p.add_argument("--out", type=Path, required=True)
    args = ap.parse_args()

    t0 = time.time()
    if args.src == "synth":
        with mp.Pool(args.workers) as pool:
            clips = pool.map(synthetic_clip, range(args.seed, args.seed + args.clips), chunksize=16)
    else:
        wavs = sorted(args.dir.glob("*.wav"))
        if not wavs:
            sys.exit(f"no .wav files in {args.dir}")
        clips = [recording_windows(w) for w in wavs]
    d = pack(clips)
    args.out.parent.mkdir(parents=True, exist_ok=True)
    np.savez_compressed(args.out, **d, label_names=np.array(LABELS))
    print(f"built {len(clips)} clips in {time.time() - t0:.0f} s -> {args.out}")
    summarize(d)


if __name__ == "__main__":
    main()
