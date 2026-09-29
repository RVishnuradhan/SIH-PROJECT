"""Training and evaluation for AncNet on packed window sets (see tools/build_dataset.py)."""
from __future__ import annotations

import json
import time
from dataclasses import asdict, dataclass
from pathlib import Path

import numpy as np
import torch
from sklearn.metrics import f1_score, roc_auc_score
from torch import nn

from .config import CONTEXT_FRAMES
from .dataset import LABELS
from .model import AncNet, count_macs, count_params


class WindowSet:
    """A packed .npz set; yields batches of (x, y, mask) without copying the whole set."""

    def __init__(self, path: Path, mics: int = 2) -> None:
        d = np.load(path)
        self.features = d["features"][:mics]           # (mics, frames, mels) float16
        self.frame = d["window_frame"]
        self.labels = d["labels"]                      # (n, 4), NaN = masked
        self.mics = mics
        self._offs = np.arange(CONTEXT_FRAMES)

    def __len__(self) -> int:
        return len(self.frame)

    def batch(self, idx: np.ndarray) -> tuple[torch.Tensor, torch.Tensor, torch.Tensor]:
        frames = self.frame[idx][:, None] + self._offs          # (B, T)
        x = self.features[:, frames].astype(np.float32)         # (mics, B, T, F)
        x = np.ascontiguousarray(x.transpose(1, 0, 2, 3))
        y = self.labels[idx]
        mask = ~np.isnan(y)
        return torch.from_numpy(x), torch.from_numpy(np.nan_to_num(y)), torch.from_numpy(mask.astype(np.float32))

    def input_stats(self) -> tuple[np.ndarray, np.ndarray]:
        f = self.features[:, ::7].astype(np.float32)            # subsample for speed
        return f.mean(axis=(1, 2)), f.std(axis=(1, 2))


@dataclass
class TrainConfig:
    mics: int = 2
    width: int = 16
    epochs: int = 8
    batch: int = 256
    lr: float = 2e-3
    weight_decay: float = 1e-4
    seed: int = 0


def masked_bce(logits: torch.Tensor, y: torch.Tensor, mask: torch.Tensor) -> torch.Tensor:
    loss = nn.functional.binary_cross_entropy_with_logits(logits, y, reduction="none")
    return (loss * mask).sum() / mask.sum().clamp(min=1)


@torch.no_grad()
def predict(model: AncNet, ds: WindowSet, batch: int = 1024) -> np.ndarray:
    model.eval()
    out = []
    for s in range(0, len(ds), batch):
        x, _, _ = ds.batch(np.arange(s, min(s + batch, len(ds))))
        out.append(torch.sigmoid(model(x)).numpy())
    return np.concatenate(out)


def evaluate(probs: np.ndarray, labels: np.ndarray) -> dict:
    res = {}
    for i, name in enumerate(LABELS):
        known = ~np.isnan(labels[:, i])
        y, p = labels[known, i], probs[known, i]
        res[name] = {
            "auc": float(roc_auc_score(y, p)) if 0 < y.mean() < 1 else float("nan"),
            "f1": float(f1_score(y, p > 0.5)),
            "accuracy": float(np.mean((p > 0.5) == y)),
            "n": int(known.sum()),
        }
    return res


def train(train_path: Path, val_path: Path, out_dir: Path, cfg: TrainConfig, log=print) -> dict:
    torch.manual_seed(cfg.seed)
    rng = np.random.default_rng(cfg.seed)
    tr, va = WindowSet(train_path, cfg.mics), WindowSet(val_path, cfg.mics)

    model = AncNet(mics=cfg.mics, width=cfg.width)
    mean, std = tr.input_stats()
    model.in_mean.copy_(torch.from_numpy(mean))
    model.in_std.copy_(torch.from_numpy(std))
    opt = torch.optim.AdamW(model.parameters(), lr=cfg.lr, weight_decay=cfg.weight_decay)
    steps = cfg.epochs * (len(tr) // cfg.batch)
    sched = torch.optim.lr_scheduler.OneCycleLR(opt, max_lr=cfg.lr, total_steps=steps)

    out_dir.mkdir(parents=True, exist_ok=True)
    best, history = -1.0, []
    for epoch in range(cfg.epochs):
        model.train()
        t0, perm, losses = time.time(), rng.permutation(len(tr)), []
        for s in range(0, len(perm) - cfg.batch + 1, cfg.batch):
            x, y, m = tr.batch(perm[s:s + cfg.batch])
            loss = masked_bce(model(x), y, m)
            opt.zero_grad()
            loss.backward()
            opt.step()
            sched.step()
            losses.append(loss.item())
        metrics = evaluate(predict(model, va), va.labels)
        score = metrics["speech"]["auc"]           # speech drives the canceller: select on it
        history.append({"epoch": epoch, "train_loss": float(np.mean(losses)), "val": metrics})
        log(f"epoch {epoch}  loss {np.mean(losses):.4f}  " +
            "  ".join(f"{k[:6]} auc {v['auc']:.3f}" for k, v in metrics.items()) +
            f"  ({time.time() - t0:.0f} s)")
        if score > best:
            best = score
            torch.save({"state_dict": model.state_dict(), "config": asdict(cfg)}, out_dir / "model.pt")

    summary = {"config": asdict(cfg), "params": count_params(model), "macs": count_macs(model),
               "best_speech_auc": best, "history": history,
               "train_set": str(train_path), "val_set": str(val_path)}
    (out_dir / "metrics.json").write_text(json.dumps(summary, indent=2))
    return summary


def load(path: Path) -> AncNet:
    ck = torch.load(path, map_location="cpu")
    cfg = TrainConfig(**ck["config"])
    model = AncNet(mics=cfg.mics, width=cfg.width)
    model.load_state_dict(ck["state_dict"])
    model.eval()
    return model
