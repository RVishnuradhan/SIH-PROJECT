"""Single-channel spectral noise suppressor (the "second stage").

The two-mic canceller only removes noise that mic 2 can predict at mic 1.
Diffuse noise -- fans, wind, reverberant rooms -- is not predictable that
way. This stage handles it: it learns the noise spectrum while nobody is
talking and turns those frequencies down, frame by frame.

Algorithm (standard, embedded-friendly):
  * STFT: 256-sample frames (16 ms), hop 128, sqrt-Hann analysis and synthesis
    -> 16 ms added latency, inside the 20-40 ms budget.
  * Noise power spectrum: recursive average, updated only in frames the speech
    detector marks as noise-only.
  * Gain: Wiener gain with decision-directed a-priori SNR (Ephraim-Malah),
    floored at `floor_db` so noise is turned down rather than gated to silence,
    which is what causes "musical noise" artefacts.

`process()` also returns the per-frame gains, so an evaluation can apply the
exact same gains to clean speech and noise separately (shadow filtering) and
measure noise reduction and speech distortion independently.
"""
from __future__ import annotations

from dataclasses import dataclass

import numpy as np

FRAME = 256
HOP = 128
_WIN = np.sqrt(0.5 - 0.5 * np.cos(2 * np.pi * np.arange(FRAME) / FRAME))   # sqrt periodic Hann


@dataclass
class PostfilterParams:
    floor_db: float = -15.0      # deepest attenuation per frequency bin
    noise_alpha: float = 0.92    # noise-spectrum smoothing (per 8 ms hop)
    dd_alpha: float = 0.98       # decision-directed smoothing
    init_frames: int = 16        # first 128 ms treated as noise to seed the estimate
    # "vad": learn noise only in frames the speech detector calls noise-only.
    # "minstat": track the minimum of the smoothed spectrum over ~1 s per
    #   frequency bin (minimum statistics). Speech has gaps in every bin even
    #   while someone talks, so the minimum follows the noise without any
    #   speech detector -- the fix for recordings where speech is almost always on.
    noise_mode: str = "vad"
    minstat_window: int = 125    # frames (~1 s) the minimum is taken over
    minstat_smooth: float = 0.85
    minstat_bias: float = 2.0    # the minimum of a noisy spectrum underestimates its mean
    over_subtract: float = 1.0   # >1 treats the noise as louder than estimated


def stft(x: np.ndarray) -> np.ndarray:
    n_frames = 1 + (len(x) - FRAME) // HOP
    idx = np.arange(FRAME)[None, :] + HOP * np.arange(n_frames)[:, None]
    return np.fft.rfft(x[idx] * _WIN, axis=1)


def istft(X: np.ndarray, n: int) -> np.ndarray:
    frames = np.fft.irfft(X, n=FRAME, axis=1) * _WIN
    out = np.zeros(n)
    for i, f in enumerate(frames):
        out[i * HOP:i * HOP + FRAME] += f
    return out


def suppress(x: np.ndarray, speech: np.ndarray, p: PostfilterParams | None = None
             ) -> tuple[np.ndarray, np.ndarray]:
    """x: signal; speech: per-sample bool (True = someone talking).
    Returns (output, gains[n_frames, bins])."""
    p = p or PostfilterParams()
    X = stft(np.asarray(x, np.float64))
    P = np.abs(X) ** 2
    frame_speech = np.array([speech[i * HOP:i * HOP + FRAME].any() for i in range(len(X))])
    floor = 10 ** (p.floor_db / 20)
    noise = P[:p.init_frames].mean(axis=0) + 1e-12
    G = np.ones_like(P)
    prev_clean = np.zeros(P.shape[1])
    smooth = P[0].copy()
    history: list[np.ndarray] = []
    for i in range(len(X)):
        if p.noise_mode == "minstat":
            smooth = p.minstat_smooth * smooth + (1 - p.minstat_smooth) * P[i]
            history.append(smooth)
            if len(history) > p.minstat_window:
                history.pop(0)
            if i >= p.init_frames:
                noise = p.minstat_bias * np.min(history, axis=0) + 1e-12
        elif i >= p.init_frames and not frame_speech[i]:
            noise = p.noise_alpha * noise + (1 - p.noise_alpha) * P[i]
        post = P[i] / (p.over_subtract * noise)
        prio = p.dd_alpha * prev_clean / (p.over_subtract * noise) + (1 - p.dd_alpha) * np.maximum(post - 1, 0)
        g = np.maximum(prio / (1 + prio), floor)
        G[i] = g
        prev_clean = (g ** 2) * P[i]
    return istft(X * G, len(x)), G


def apply_gains(x: np.ndarray, G: np.ndarray) -> np.ndarray:
    """Apply previously computed gains to another signal (shadow filtering)."""
    return istft(stft(np.asarray(x, np.float64)) * G, len(x))
