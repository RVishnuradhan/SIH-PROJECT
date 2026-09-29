"""Speech-quality metrics.

SNR and SI-SDR are computed here directly. STOI and PESQ measure
intelligibility and perceived quality; they are only meaningful on REAL
speech, so they are not computed against the synthetic speech generator.
"""
from __future__ import annotations

import numpy as np


def _align(ref: np.ndarray, est: np.ndarray, delay: int) -> tuple[np.ndarray, np.ndarray]:
    """Shift `est` earlier by `delay` samples (the canceller's latency)."""
    if delay:
        est = est[delay:]
        ref = ref[: len(est)]
    n = min(len(ref), len(est))
    return np.asarray(ref[:n], np.float64), np.asarray(est[:n], np.float64)


def snr_db(clean: np.ndarray, est: np.ndarray, delay: int = 0) -> float:
    """10 log10(|clean|^2 / |est - clean|^2)."""
    c, e = _align(clean, est, delay)
    return float(10 * np.log10(np.sum(c ** 2) / (np.sum((e - c) ** 2) + 1e-20)))


def si_sdr_db(clean: np.ndarray, est: np.ndarray, delay: int = 0) -> float:
    """Scale-invariant SDR: like SNR but ignores an overall gain difference,
    so a canceller that just makes everything quieter gets no credit."""
    c, e = _align(clean, est, delay)
    c = c - c.mean()
    e = e - e.mean()
    target = (e @ c) / (c @ c + 1e-20) * c
    return float(10 * np.log10(np.sum(target ** 2) / (np.sum((e - target) ** 2) + 1e-20)))


def noise_reduction_db(noise_before: np.ndarray, noise_after: np.ndarray) -> float:
    return float(10 * np.log10(np.sum(np.square(noise_before, dtype=np.float64)) /
                               (np.sum(np.square(noise_after, dtype=np.float64)) + 1e-20)))
