#!/usr/bin/env python3
"""Train the neural noise suppressor (anc.denoiser.DenoiseNet).

    python tools/train_denoiser.py --train data/sets/denoise_train.npz \
        --val data/sets/denoise_val.npz --out runs/denoiser
"""
from __future__ import annotations

import argparse
import json
import sys
import time
from pathlib import Path

import numpy as np
import torch

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "src"))
from anc.denoiser import DenoiseNet  # noqa: E402


def loss_fn(g_hat: torch.Tensor, g: torch.Tensor) -> torch.Tensor:
    # sqrt emphasises errors on small gains (where the noise is), as in RNNoise;
    # the BCE term keeps gains decisive instead of hedging around 0.5.
    return torch.mean((g_hat.clamp_min(1e-6).sqrt() - g.sqrt()) ** 2) + \
        0.1 * torch.nn.functional.binary_cross_entropy(g_hat.clamp(1e-6, 1 - 1e-6), g)


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--train", type=Path, required=True)
    ap.add_argument("--val", type=Path, required=True)
    ap.add_argument("--out", type=Path, required=True)
    ap.add_argument("--epochs", type=int, default=20)
    ap.add_argument("--batch", type=int, default=32)
    ap.add_argument("--lr", type=float, default=2e-3)
    ap.add_argument("--hidden", type=int, default=96)
    ap.add_argument("--threads", type=int, default=4)
    a = ap.parse_args()
    torch.set_num_threads(a.threads)
    torch.manual_seed(0)

    tr, va = np.load(a.train), np.load(a.val)
    Ft, Gt = torch.from_numpy(tr["features"].astype(np.float32)), torch.from_numpy(tr["gains"].astype(np.float32))
    Fv, Gv = torch.from_numpy(va["features"].astype(np.float32)), torch.from_numpy(va["gains"].astype(np.float32))
    m = DenoiseNet(hidden=a.hidden)
    m.in_mean.copy_(Ft.reshape(-1, Ft.shape[-1]).mean(0))
    m.in_std.copy_(Ft.reshape(-1, Ft.shape[-1]).std(0) + 1e-3)
    opt = torch.optim.AdamW(m.parameters(), lr=a.lr, weight_decay=1e-4)
    steps = a.epochs * (len(Ft) // a.batch)
    sched = torch.optim.lr_scheduler.OneCycleLR(opt, max_lr=a.lr, total_steps=steps)
    a.out.mkdir(parents=True, exist_ok=True)
    best, hist = 1e9, []
    for ep in range(a.epochs):
        m.train(); t0 = time.time(); perm = torch.randperm(len(Ft)); losses = []
        for i in range(0, len(Ft) - a.batch + 1, a.batch):
            idx = perm[i:i + a.batch]
            g_hat, _ = m(Ft[idx])
            loss = loss_fn(g_hat, Gt[idx])
            opt.zero_grad(); loss.backward()
            torch.nn.utils.clip_grad_norm_(m.parameters(), 1.0)
            opt.step(); sched.step(); losses.append(loss.item())
        m.eval()
        with torch.no_grad():
            vl = float(np.mean([loss_fn(m(Fv[i:i + 100])[0], Gv[i:i + 100]).item() for i in range(0, len(Fv), 100)]))
        hist.append({"epoch": ep, "train": float(np.mean(losses)), "val": vl})
        print(f"epoch {ep:2d}  train {np.mean(losses):.4f}  val {vl:.4f}  ({time.time() - t0:.0f} s)", flush=True)
        if vl < best:
            best = vl
            torch.save({"state_dict": m.state_dict(), "hidden": a.hidden}, a.out / "denoiser.pt")
    (a.out / "history.json").write_text(json.dumps(hist, indent=2))
    print(f"best val loss {best:.4f} -> {a.out}/denoiser.pt")


if __name__ == "__main__":
    main()
