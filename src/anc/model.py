"""The classifier: a small CNN over two-mic log-mel windows.

Kept deliberately small and built only from ops that map directly onto the
ESP32-S3 (3x3 conv, ReLU, max-pool, global average, dense), so it can be run
either through TFLite Micro or hand-written with ESP-NN kernels.

Input  (batch, mics, CONTEXT_FRAMES, N_MELS) log-mel dB
Output (batch, 4) logits in anc.dataset.LABELS order:
       stationary, non_stationary, impulsive, speech
"""
from __future__ import annotations

import torch
from torch import nn

from .config import CONTEXT_FRAMES, N_MELS
from .dataset import N_LABELS


def _block(cin: int, cout: int) -> nn.Sequential:
    # BatchNorm is folded into the conv weights at export, so it costs nothing on device.
    return nn.Sequential(nn.Conv2d(cin, cout, 3, padding=1, bias=False), nn.BatchNorm2d(cout), nn.ReLU())


class AncNet(nn.Module):
    def __init__(self, mics: int = 2, width: int = 16) -> None:
        super().__init__()
        self.mics = mics
        # Fixed input normalisation, set from the training set and stored with
        # the weights so the device applies exactly the same transform.
        self.register_buffer("in_mean", torch.zeros(mics))
        self.register_buffer("in_std", torch.ones(mics))
        self.features = nn.Sequential(
            _block(mics, width), nn.MaxPool2d(2),           # 25x40 -> 12x20
            _block(width, 2 * width), nn.MaxPool2d(2),      # 12x20 -> 6x10
            _block(2 * width, 2 * width),
            nn.AdaptiveAvgPool2d(1),
        )
        self.head = nn.Sequential(nn.Flatten(), nn.Linear(2 * width, 2 * width), nn.ReLU(),
                                  nn.Linear(2 * width, N_LABELS))

    def forward(self, x: torch.Tensor) -> torch.Tensor:
        x = (x - self.in_mean[None, :, None, None]) / self.in_std[None, :, None, None]
        return self.head(self.features(x))


def count_params(model: nn.Module) -> int:
    return sum(p.numel() for p in model.parameters())


def count_macs(model: AncNet) -> int:
    """Multiply-accumulates for one window, the number that sets device cost."""
    macs = 0
    h, w = CONTEXT_FRAMES, N_MELS
    for m in model.modules():
        if isinstance(m, nn.Conv2d):
            macs += h * w * m.in_channels * m.out_channels * m.kernel_size[0] * m.kernel_size[1]
        elif isinstance(m, nn.MaxPool2d):
            h, w = h // 2, w // 2
        elif isinstance(m, nn.Linear):
            macs += m.in_features * m.out_features
    return macs
