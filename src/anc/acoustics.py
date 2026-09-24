r"""Minimal two-mic acoustic scene for simulating the canceller.

Geometry this models (the soldier unit, mics a few cm apart):

    noise source ))) --[shared path]--+-- reference mic (faces outward, hears noise first)
                                      +-- primary mic (at the mouth)  <--- speech

Because the mics are close together, the noise reaching them has travelled the
same path through the environment (`h_common`) and differs only by a short
local path to each mic. That is the coherent-field regime in which two-mic
adaptive cancellation works: the filter only has to learn the short local
difference.

What limits cancellation in reality is the part of the noise that does NOT
match between the mics: wind turbulence on one mic, local reflections off the
body, sensor self-noise. `incoherent_db` sets that level relative to the
coherent noise, and it caps the achievable noise reduction at roughly
-incoherent_db. Measuring it on the real hardware is part of bring-up.

Speech also leaks into the reference mic at reduced level (`speech_leak_db`).
That is why the canceller must stop adapting while the soldier talks.
"""
from __future__ import annotations

from dataclasses import dataclass

import numpy as np
from scipy.signal import fftconvolve

from .config import SAMPLE_RATE


def room_ir(rng: np.random.Generator, delay: int, length: int = 64, rt_ms: float = 2.0,
            tail_gain: float = 0.1, gain: float = 1.0) -> np.ndarray:
    """Direct path at `delay` samples plus a decaying reflection tail."""
    h = np.zeros(delay + length)
    h[delay] = gain
    decay = np.exp(-np.arange(1, length) / (rt_ms * SAMPLE_RATE / 1000))
    h[delay + 1:] = tail_gain * gain * rng.standard_normal(length - 1) * decay
    return h


def _rms(v: np.ndarray) -> float:
    return float(np.sqrt(np.mean(np.square(v, dtype=np.float64))) + 1e-12)


@dataclass
class Scene:
    primary: np.ndarray             # what mic 1 hears
    reference: np.ndarray           # what mic 2 hears
    speech_at_primary: np.ndarray   # the clean target, as it arrives at mic 1
    noise_at_primary: np.ndarray    # everything that is not speech at mic 1


def make_scene(
    speech: np.ndarray,
    noise: np.ndarray,
    rng: np.random.Generator,
    snr_db: float = 0.0,
    speech_leak_db: float = -20.0,
    incoherent_db: float = -25.0,
    sensor_noise_db: float = -60.0,
) -> Scene:
    """Mix `speech` and `noise` (same length) into the two mics.

    snr_db:          speech-to-noise at the primary mic.
    speech_leak_db:  speech level at the reference relative to the primary (-inf for none).
    incoherent_db:   uncorrelated noise at each mic relative to the coherent noise.
    """
    n = len(speech)
    common = fftconvolve(noise, room_ir(rng, delay=0, length=256, rt_ms=10.0, tail_gain=0.3))[:n]
    # Reference faces the noise: hears it ~0.5 ms before the primary.
    n_ref = fftconvolve(common, room_ir(rng, delay=2, length=16, rt_ms=0.3))[:n]
    n_pri = fftconvolve(common, room_ir(rng, delay=10, length=16, rt_ms=0.3, gain=0.8))[:n]
    s_pri = fftconvolve(speech, room_ir(rng, delay=1, length=16, rt_ms=0.3))[:n]

    # Incoherent part: independent at each mic, same spectrum as the noise.
    if np.isfinite(incoherent_db):
        for arr in (n_ref, n_pri):
            shuffled = np.fft.irfft(np.abs(np.fft.rfft(common)) *
                                    np.exp(2j * np.pi * rng.random(n // 2 + 1)), n=n)
            arr += shuffled * _rms(arr) / _rms(shuffled) * 10 ** (incoherent_db / 20)

    scale = _rms(s_pri) / (_rms(n_pri) * 10 ** (snr_db / 20))
    n_pri, n_ref = n_pri * scale, n_ref * scale

    s_ref = np.zeros(n)
    if np.isfinite(speech_leak_db):
        s_ref = fftconvolve(speech, room_ir(rng, delay=4, length=32, rt_ms=1.0))[:n]
        s_ref *= _rms(s_pri) * 10 ** (speech_leak_db / 20) / _rms(s_ref)

    floor = _rms(s_pri) * 10 ** (sensor_noise_db / 20)
    n_pri = n_pri + floor * rng.standard_normal(n)
    n_ref = n_ref + floor * rng.standard_normal(n)
    return Scene((s_pri + n_pri).astype(np.float32), (n_ref + s_ref).astype(np.float32),
                 s_pri.astype(np.float32), n_pri.astype(np.float32))
