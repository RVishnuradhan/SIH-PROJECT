"""Log-mel feature extraction.

Written in plain NumPy rather than pulled from librosa on purpose: this code
has to be reimplemented in C on the MCU, so every step here is one we are
willing to write twice. The mel filterbank is precomputed once and can be
dumped straight to a C array (see `mel_filterbank_as_c_array`).
"""
from __future__ import annotations

import numpy as np

from .config import FeatureConfig, DEFAULT_FEATURES


def hz_to_mel(f: np.ndarray | float) -> np.ndarray | float:
    """HTK mel scale. Chosen over the Slaney scale for its one-line inverse."""
    return 2595.0 * np.log10(1.0 + np.asarray(f, dtype=np.float64) / 700.0)


def mel_to_hz(m: np.ndarray | float) -> np.ndarray | float:
    return 700.0 * (10.0 ** (np.asarray(m, dtype=np.float64) / 2595.0) - 1.0)


def mel_filterbank(cfg: FeatureConfig = DEFAULT_FEATURES) -> np.ndarray:
    """Triangular mel filterbank, shape (n_mels, n_fft // 2 + 1).

    Filters are area-normalised so that a flat-spectrum input gives a flat mel
    response regardless of how wide each band is -- without this, high bands
    dominate purely because they are wider.
    """
    n_bins = cfg.n_fft // 2 + 1
    fft_freqs = np.linspace(0.0, cfg.sample_rate / 2.0, n_bins)

    # n_mels + 2 edges: each filter spans [edge[i], edge[i+2]], peaking at edge[i+1].
    mel_edges = np.linspace(hz_to_mel(cfg.fmin), hz_to_mel(cfg.fmax), cfg.n_mels + 2)
    hz_edges = mel_to_hz(mel_edges)

    fb = np.zeros((cfg.n_mels, n_bins), dtype=np.float64)
    for i in range(cfg.n_mels):
        lo, mid, hi = hz_edges[i], hz_edges[i + 1], hz_edges[i + 2]
        # Rising then falling edge; np.maximum(...,0) clips outside the triangle.
        rising = (fft_freqs - lo) / max(mid - lo, 1e-9)
        falling = (hi - fft_freqs) / max(hi - mid, 1e-9)
        fb[i] = np.maximum(0.0, np.minimum(rising, falling))

    # Slaney-style area normalisation.
    widths = hz_edges[2:] - hz_edges[:-2]
    fb *= (2.0 / np.maximum(widths, 1e-9))[:, None]
    return fb.astype(np.float32)


def _hann(win_length: int) -> np.ndarray:
    """Periodic Hann window (the STFT-correct variant, not the symmetric one)."""
    n = np.arange(win_length, dtype=np.float64)
    return (0.5 - 0.5 * np.cos(2.0 * np.pi * n / win_length)).astype(np.float32)


def frame_signal(x: np.ndarray, cfg: FeatureConfig = DEFAULT_FEATURES) -> np.ndarray:
    """Split into overlapping frames, shape (n_frames, win_length).

    No padding and no centering: frame k starts at exactly k * hop_length. That
    matches what a real-time ring buffer on the MCU can do, where there is no
    future audio to pad with.
    """
    x = np.asarray(x, dtype=np.float32)
    if x.ndim != 1:
        raise ValueError(f"expected mono 1-D signal, got shape {x.shape}")
    n_frames = 1 + (len(x) - cfg.win_length) // cfg.hop_length if len(x) >= cfg.win_length else 0
    if n_frames <= 0:
        return np.zeros((0, cfg.win_length), dtype=np.float32)
    idx = np.arange(cfg.win_length)[None, :] + cfg.hop_length * np.arange(n_frames)[:, None]
    return x[idx]


def power_spectrum(x: np.ndarray, cfg: FeatureConfig = DEFAULT_FEATURES) -> np.ndarray:
    """Windowed magnitude-squared STFT, shape (n_frames, n_fft // 2 + 1)."""
    frames = frame_signal(x, cfg)
    if frames.shape[0] == 0:
        return np.zeros((0, cfg.n_fft // 2 + 1), dtype=np.float32)
    windowed = frames * _hann(cfg.win_length)[None, :]
    spec = np.fft.rfft(windowed, n=cfg.n_fft, axis=-1)
    return (spec.real ** 2 + spec.imag ** 2).astype(np.float32)


def log_mel(
    x: np.ndarray,
    cfg: FeatureConfig = DEFAULT_FEATURES,
    fb: np.ndarray | None = None,
    floor_db: float = -80.0,
) -> np.ndarray:
    """Log-mel spectrogram in dB, shape (n_frames, n_mels).

    The output is floored at `floor_db` relative to a fixed reference of 1.0,
    NOT relative to each clip's own peak. Per-clip peak normalisation would
    destroy the absolute level information the classifier needs -- a quiet
    steady hum and a loud steady hum call for different ANC step sizes.
    """
    if fb is None:
        fb = mel_filterbank(cfg)
    power = power_spectrum(x, cfg)
    mel_power = power @ fb.T
    ref = 1.0
    db = 10.0 * np.log10(np.maximum(mel_power, 1e-10) / ref)
    return np.maximum(db, floor_db).astype(np.float32)


def mel_filterbank_as_c_array(cfg: FeatureConfig = DEFAULT_FEATURES, name: str = "mel_fb") -> str:
    """Emit the filterbank as a C float array for the embedded port.

    Stored sparsely (start bin + run of weights per filter) because a dense
    40 x 257 float matrix is 41 kB, which is a lot of MCU flash to spend on
    mostly zeros.
    """
    fb = mel_filterbank(cfg)
    lines = [
        f"/* Generated from anc.features -- {cfg.n_mels} mel bands, "
        f"{cfg.n_fft}-point FFT, {cfg.sample_rate} Hz. Do not edit by hand. */",
        f"#define {name.upper()}_N_MELS {cfg.n_mels}",
        f"#define {name.upper()}_N_BINS {cfg.n_fft // 2 + 1}",
    ]
    starts, lengths, weights = [], [], []
    for row in fb:
        nz = np.nonzero(row)[0]
        if len(nz) == 0:
            starts.append(0)
            lengths.append(0)
            continue
        starts.append(int(nz[0]))
        lengths.append(int(nz[-1] - nz[0] + 1))
        weights.extend(row[nz[0]: nz[-1] + 1].tolist())

    def _arr(decl: str, vals, fmt) -> str:
        body = ", ".join(fmt(v) for v in vals)
        return f"static const {decl} = {{ {body} }};"

    lines.append(_arr(f"uint16_t {name}_start[{cfg.n_mels}]", starts, lambda v: str(v)))
    lines.append(_arr(f"uint16_t {name}_len[{cfg.n_mels}]", lengths, lambda v: str(v)))
    lines.append(_arr(f"float {name}_weights[{len(weights)}]", weights, lambda v: f"{v:.8g}f"))
    return "\n".join(lines)
