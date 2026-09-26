"""Neural noise suppressor: a small recurrent network that predicts, every
8 ms, how much to turn down each of 24 frequency bands so that the voice
stays and the noise goes.

Same idea as RNNoise and the noise suppression in video-call apps, sized for
the ESP32-S3:

    mic -> 60 Hz high-pass (as the training data)
        -> STFT (256 / 128, sqrt-Hann)            16 ms latency
        -> log energy in 24 mel bands             24 features per frame
        -> Dense 64 -> GRU 96 -> GRU 96 -> Dense 24, sigmoid   (band gains)
        -> gains interpolated to the 129 FFT bins -> inverse STFT

Trained on clean speech + noise mixtures with the ideal band gain
sqrt(E_speech / E_mixture) as the target. Runs entirely on the device; the
internet is only used once, to download training data.
"""
from __future__ import annotations

from pathlib import Path

import numpy as np
import torch
from scipy.signal import butter, sosfilt
from torch import nn

from .config import SAMPLE_RATE
from .features import hz_to_mel, mel_to_hz
from .postfilter import FRAME, HOP, istft, stft

N_BINS = FRAME // 2 + 1
N_BANDS = 24

# First-order 60 Hz high-pass. The training mixtures are built from filtered
# speech and noise, and the device filters its input the same way. Without it
# the board's breath puffs and DC drift (below 20 Hz, up to 26 dB above what
# training speech has there) reach the network as a sound it never learned.
HIGHPASS_SOS = butter(1, 60, "highpass", fs=SAMPLE_RATE, output="sos")


def highpass(x: np.ndarray) -> np.ndarray:
    return sosfilt(HIGHPASS_SOS, x)


def band_matrix(n_bands: int = N_BANDS) -> np.ndarray:
    """Triangular mel bands, shape (bands, bins). Columns sum to 1, so the
    same matrix both pools bin energies into bands and spreads band gains back
    over bins without gaps or bumps."""
    freqs = np.linspace(0, SAMPLE_RATE / 2, N_BINS)
    centers = mel_to_hz(np.linspace(hz_to_mel(0.0), hz_to_mel(SAMPLE_RATE / 2), n_bands))
    W = np.zeros((n_bands, N_BINS))
    for b in range(n_bands):
        lo = centers[b - 1] if b > 0 else centers[0] - 1e-9
        hi = centers[b + 1] if b < n_bands - 1 else centers[-1] + 1e-9
        c = centers[b]
        # Edge bands are half-triangles. The 1e-6 tolerance matters: the top
        # centre round-trips through the mel scale to 8000.0000001 Hz, which
        # would otherwise leave the top band with no bins at all.
        rise = (freqs - lo) / max(c - lo, 1e-9) if b > 0 else (freqs <= c + 1e-6).astype(float)
        fall = (hi - freqs) / max(hi - c, 1e-9) if b < n_bands - 1 else (freqs >= c - 1e-6).astype(float)
        W[b] = np.clip(np.minimum(rise, fall), 0, 1)
    return (W / W.sum(axis=0, keepdims=True)).astype(np.float32)


BANDS = band_matrix()


def band_energy(X: np.ndarray) -> np.ndarray:
    """|STFT|^2 pooled into bands: (frames, bins) complex -> (frames, bands)."""
    return (np.abs(X) ** 2) @ BANDS.T


def features(X: np.ndarray) -> np.ndarray:
    return np.log10(band_energy(X) + 1e-10).astype(np.float32)


class DenoiseNet(nn.Module):
    def __init__(self, hidden: int = 96) -> None:
        super().__init__()
        self.register_buffer("in_mean", torch.zeros(N_BANDS))
        self.register_buffer("in_std", torch.ones(N_BANDS))
        self.inp = nn.Sequential(nn.Linear(N_BANDS, 64), nn.Tanh())
        self.gru1 = nn.GRU(64, hidden, batch_first=True)
        self.gru2 = nn.GRU(hidden, hidden, batch_first=True)
        self.out = nn.Sequential(nn.Linear(hidden, N_BANDS), nn.Sigmoid())

    def forward(self, f: torch.Tensor, state=None):
        """f: (batch, frames, bands) log band energies -> gains (batch, frames, bands)."""
        h1, h2 = (None, None) if state is None else state
        x = self.inp((f - self.in_mean) / self.in_std)
        x, h1 = self.gru1(x, h1)
        x, h2 = self.gru2(x, h2)
        return self.out(x), (h1, h2)


def ideal_gains(S: np.ndarray, X: np.ndarray) -> np.ndarray:
    """Training target: sqrt(speech band energy / mixture band energy), clipped to [0, 1]."""
    return np.clip(np.sqrt(band_energy(S) / (band_energy(X) + 1e-10)), 0, 1).astype(np.float32)


def gains_to_bins(g: np.ndarray) -> np.ndarray:
    return g @ BANDS


@torch.no_grad()
def denoise(model: DenoiseNet, x: np.ndarray, floor_db: float = -30.0, filtered: bool = False
            ) -> tuple[np.ndarray, np.ndarray]:
    """Run the network over a whole signal. Returns (output, per-bin gains).
    `filtered=True` skips the high-pass, for input that has already had it."""
    model.eval()
    x = np.asarray(x, np.float64)
    X = stft(x if filtered else highpass(x))
    g, _ = model(torch.from_numpy(features(X))[None])
    G = np.maximum(gains_to_bins(g[0].numpy()), 10 ** (floor_db / 20))
    return istft(X * G, len(x)), G


def load(path: Path) -> DenoiseNet:
    ck = torch.load(path, map_location="cpu")
    m = DenoiseNet(hidden=ck.get("hidden", 96))
    m.load_state_dict(ck["state_dict"])
    m.eval()
    return m


# ---- Export for the ESP32 -------------------------------------------------
#
# The device keeps the weights in internal RAM, where 106k float32 weights
# (425 KB) would not fit. Each weight row is stored as int8 with one float
# scale per row (106 KB); the device computes scale * sum(q * x) in float,
# which is exactly the float network with weights q * scale. `dequantized()`
# builds that network in PyTorch, so the C port can be checked against it.

BLOB_MAGIC = b"ANCD"
BLOB_VERSION = 2


def _layers(m: DenoiseNet):
    """(weight, bias) pairs in the order the C code reads them."""
    return [(m.inp[0].weight, m.inp[0].bias),
            (m.gru1.weight_ih_l0, m.gru1.bias_ih_l0), (m.gru1.weight_hh_l0, m.gru1.bias_hh_l0),
            (m.gru2.weight_ih_l0, m.gru2.bias_ih_l0), (m.gru2.weight_hh_l0, m.gru2.bias_hh_l0),
            (m.out[0].weight, m.out[0].bias)]


def quantize_rows(w: np.ndarray) -> tuple[np.ndarray, np.ndarray]:
    """Symmetric int8 per output row: w ~= q * scale[:, None]."""
    scale = np.abs(w).max(axis=1) / 127.0
    scale[scale == 0] = 1.0
    q = np.clip(np.round(w / scale[:, None]), -127, 127).astype(np.int8)
    return q, scale.astype(np.float32)


@torch.no_grad()
def dequantized(model: DenoiseNet) -> DenoiseNet:
    """Copy of `model` with every weight matrix replaced by its int8 version."""
    m = DenoiseNet(hidden=model.gru1.hidden_size)
    m.load_state_dict(model.state_dict())
    for w, _ in _layers(m):
        q, s = quantize_rows(w.numpy())
        w.copy_(torch.from_numpy(q.astype(np.float32) * s[:, None]))
    return m.eval()


@torch.no_grad()
def export_blob(model: DenoiseNet) -> bytes:
    """Serialise for firmware/anc_unit/components/anc_denoise (little-endian):

    "ANCD", u32 version, u32 bands, u32 dense, u32 hidden, u32 bins,
    f32 highpass b0, b1, a1 (y = b0 x + b1 x[-1] - a1 y[-1]),
    f32 in_mean[bands], f32 in_std[bands], f32 band_matrix[bands][bins],
    then per layer (input dense, gru1 ih, gru1 hh, gru2 ih, gru2 hh, output):
    u32 rows, u32 cols, f32 scale[rows], f32 bias[rows], i8 w[rows][cols]
    (padded to 4 bytes).
    """
    import struct
    hidden = model.gru1.hidden_size
    dense = model.inp[0].out_features
    b0, b1, _, _, a1, _ = HIGHPASS_SOS[0]
    parts = [BLOB_MAGIC, struct.pack("<5I", BLOB_VERSION, N_BANDS, dense, hidden, N_BINS),
             struct.pack("<3f", b0, b1, a1), model.in_mean.numpy().astype("<f4").tobytes(), model.in_std.numpy().astype("<f4").tobytes(),
             BANDS.astype("<f4").tobytes()]
    for w, b in _layers(model):
        q, s = quantize_rows(w.numpy())
        raw = q.tobytes()
        parts += [struct.pack("<2I", *q.shape), s.astype("<f4").tobytes(),
                  b.numpy().astype("<f4").tobytes(), raw, b"\0" * (-len(raw) % 4)]
    return b"".join(parts)
