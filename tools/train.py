#!/usr/bin/env python3
"""Train the classifier.

    python tools/train.py --train data/sets/synth_train.npz --val data/sets/synth_val.npz --out runs/synth_2mic
    python tools/train.py ... --mics 1 --out runs/synth_1mic      # primary mic only, for comparison
"""
from __future__ import annotations

import argparse
import sys
from pathlib import Path

import torch

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "src"))
from anc.training import TrainConfig, train  # noqa: E402


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--train", type=Path, required=True)
    ap.add_argument("--val", type=Path, required=True)
    ap.add_argument("--out", type=Path, required=True)
    ap.add_argument("--mics", type=int, default=2, choices=(1, 2))
    ap.add_argument("--epochs", type=int, default=8)
    ap.add_argument("--width", type=int, default=16)
    ap.add_argument("--seed", type=int, default=0)
    ap.add_argument("--threads", type=int, default=4)
    a = ap.parse_args()
    torch.set_num_threads(a.threads)
    s = train(a.train, a.val, a.out, TrainConfig(mics=a.mics, epochs=a.epochs, width=a.width, seed=a.seed))
    print(f"best val speech AUC {s['best_speech_auc']:.3f} -> {a.out}/model.pt")


if __name__ == "__main__":
    main()
