"""Synthetic defence-noise and speech generators.

WHY SYNTHETIC: real defence noise corpora are not public, and this build
environment cannot reach the public audio datasets either (Zenodo / OpenSLR
are blocked). So the pipeline is developed and measured against signals we
generate from physical models of the sources named in the problem statement.

WHAT THIS IS AND IS NOT: a model trained only on this data will NOT transfer
to real recordings. The point of this module is to exercise and measure the
whole pipeline end to end, and to define the label contract that real
recordings drop into via `anc.dataset.RecordingDataset`. Treat every accuracy
number produced from synthetic data as a pipeline check, never as a result.

Each generator returns float32 mono at config.SAMPLE_RATE, roughly unit RMS;
mixing and SNR scaling is handled in `dataset.py`.
"""
from __future__ import annotations

import numpy as np

from .config import SAMPLE_RATE


def _rms(x: np.ndarray) -> float:
    return float(np.sqrt(np.mean(np.square(x, dtype=np.float64)) + 1e-20))


def _normalize(x: np.ndarray) -> np.ndarray:
    return (x / _rms(x)).astype(np.float32)


def colored_noise(n: int, exponent: float, rng: np.random.Generator) -> np.ndarray:
    """Noise with a 1/f**exponent power spectrum.

    exponent=0 white, 1 pink, 2 brown. Engine and wind noise both sit well
    below white -- most of their energy is low-frequency.
    """
    white = rng.standard_normal(n)
    spec = np.fft.rfft(white)
    freqs = np.fft.rfftfreq(n, d=1.0 / SAMPLE_RATE)
    scale = np.ones_like(freqs)
    scale[1:] = freqs[1:] ** (-exponent / 2.0)
    scale[0] = scale[1] if len(scale) > 1 else 1.0
    return _normalize(np.fft.irfft(spec * scale, n=n))


# --- Stationary ----------------------------------------------------------

def engine_hum(
    n: int,
    rng: np.random.Generator,
    f0: float | None = None,
    n_harmonics: int = 14,
    noise_ratio: float = 0.35,
) -> np.ndarray:
    """Steady engine or generator: a harmonic stack over a broadband floor.

    f0 is the firing frequency. A 4-stroke diesel at 1500 rpm fires at
    1500/60 * (cylinders/2) Hz, which lands in the 25-100 Hz range for the
    vehicle and genset sizes this system targets.
    """
    if f0 is None:
        f0 = float(rng.uniform(28.0, 110.0))
    t = np.arange(n, dtype=np.float64) / SAMPLE_RATE
    sig = np.zeros(n, dtype=np.float64)
    for k in range(1, n_harmonics + 1):
        fk = f0 * k
        if fk >= SAMPLE_RATE / 2:
            break
        # Harmonics roll off ~1/k, with per-harmonic variation: real engines
        # have strong half-orders and uneven harmonic structure.
        amp = (1.0 / k) * float(rng.uniform(0.5, 1.5))
        phase = float(rng.uniform(0, 2 * np.pi))
        sig += amp * np.sin(2 * np.pi * fk * t + phase)
    sig = _normalize(sig)
    floor = colored_noise(n, exponent=1.2, rng=rng)
    return _normalize((1.0 - noise_ratio) * sig + noise_ratio * floor)


def machinery_hum(n: int, rng: np.random.Generator) -> np.ndarray:
    """Fan / cooling / hydraulics: a blade-pass tone plus broadband hiss.

    Higher fundamental and a flatter noise floor than `engine_hum`, so the
    classifier cannot learn 'stationary' from low-frequency energy alone.
    """
    f_blade = float(rng.uniform(120.0, 700.0))
    t = np.arange(n, dtype=np.float64) / SAMPLE_RATE
    tone = np.zeros(n, dtype=np.float64)
    for k in range(1, 5):
        if f_blade * k >= SAMPLE_RATE / 2:
            break
        tone += (1.0 / (k ** 1.5)) * np.sin(2 * np.pi * f_blade * k * t + rng.uniform(0, 2 * np.pi))
    floor = colored_noise(n, exponent=float(rng.uniform(0.2, 0.8)), rng=rng)
    mix = float(rng.uniform(0.3, 0.6))
    return _normalize(mix * _normalize(tone) + (1.0 - mix) * floor)


# --- Non-stationary ------------------------------------------------------

def engine_rev(n: int, rng: np.random.Generator, n_harmonics: int = 14) -> np.ndarray:
    """Engine under changing load: the harmonic stack sweeps with rpm.

    Implemented by integrating an instantaneous-frequency contour into phase,
    so harmonics stay locked to the fundamental as it moves -- resampling a
    steady tone would not do that.
    """
    t = np.arange(n, dtype=np.float64) / SAMPLE_RATE
    dur = n / SAMPLE_RATE
    f_lo = float(rng.uniform(25.0, 60.0))
    f_hi = f_lo * float(rng.uniform(1.6, 3.5))
    # A couple of slow rev cycles across the clip.
    rate = float(rng.uniform(0.3, 1.5))
    contour = f_lo + (f_hi - f_lo) * 0.5 * (1.0 - np.cos(2 * np.pi * rate * t / max(dur, 1e-9) * dur))
    phase = 2 * np.pi * np.cumsum(contour) / SAMPLE_RATE

    sig = np.zeros(n, dtype=np.float64)
    for k in range(1, n_harmonics + 1):
        if float(contour.max()) * k >= SAMPLE_RATE / 2:
            break
        sig += (1.0 / k) * float(rng.uniform(0.5, 1.5)) * np.sin(k * phase + rng.uniform(0, 2 * np.pi))
    sig = _normalize(sig)
    floor = colored_noise(n, exponent=1.2, rng=rng)
    return _normalize(0.7 * sig + 0.3 * floor)


def vehicle_passby(n: int, rng: np.random.Generator) -> np.ndarray:
    """Vehicle passing: amplitude swell plus a Doppler-shifted harmonic stack.

    Both cues are real and both are non-stationary, which is the point -- a
    classifier that only watched the envelope would confuse this with a wind
    gust, so the frequency shift has to be there too.
    """
    t = np.arange(n, dtype=np.float64) / SAMPLE_RATE
    dur = max(n / SAMPLE_RATE, 1e-9)
    t_closest = dur * float(rng.uniform(0.35, 0.65))
    # Closest-approach distance in "seconds of travel" -- sets how sharp the pass is.
    b = float(rng.uniform(0.15, 0.5))
    rel = (t - t_closest) / b
    envelope = 1.0 / (1.0 + rel ** 2)                      # Lorentzian swell
    doppler = 1.0 + 0.12 * (-rel) / np.sqrt(1.0 + rel ** 2)  # +12% approaching, -12% receding

    f0 = float(rng.uniform(35.0, 90.0))
    phase = 2 * np.pi * np.cumsum(f0 * doppler) / SAMPLE_RATE
    sig = np.zeros(n, dtype=np.float64)
    for k in range(1, 12):
        if f0 * 1.2 * k >= SAMPLE_RATE / 2:
            break
        sig += (1.0 / k) * np.sin(k * phase + rng.uniform(0, 2 * np.pi))
    tyre = colored_noise(n, exponent=0.6, rng=rng)  # tyre/road noise is broader-band
    return _normalize(envelope * (0.6 * _normalize(sig) + 0.4 * tyre))


def wind_gust(n: int, rng: np.random.Generator) -> np.ndarray:
    """Wind buffeting a microphone: low-frequency noise under a gusting envelope.

    The envelope itself is smoothed noise rather than a sine, because gusts are
    irregular -- a periodic envelope would be an easy, unrealistic cue.
    """
    base = colored_noise(n, exponent=float(rng.uniform(1.5, 2.5)), rng=rng)
    # Envelope: white noise low-passed to ~0.3-1.5 Hz by moving average.
    gust_hz = float(rng.uniform(0.3, 1.5))
    win = max(int(SAMPLE_RATE / gust_hz), 2)
    raw = rng.standard_normal(n + win)
    kernel = np.ones(win) / win
    env = np.convolve(raw, kernel, mode="valid")[:n]
    env = np.abs(env)
    env = env / (env.max() + 1e-9)
    env = 0.15 + 0.85 * env       # never fully silent
    return _normalize(base * env)


# --- Impulsive -----------------------------------------------------------

def impulse_burst(
    n: int,
    rng: np.random.Generator,
    rate_hz: float | None = None,
) -> np.ndarray:
    """Gunfire / blast: sparse sharp transients with exponential decay tails.

    Each event is a near-instantaneous attack followed by a fast decay and a
    slower reverberant tail. This is the case ordinary NLMS handles worst --
    the filter chases the transient and takes tens of ms to recover -- which is
    exactly why detecting it separately is worth the model.
    """
    if rate_hz is None:
        rate_hz = float(rng.uniform(1.5, 8.0))
    out = np.zeros(n, dtype=np.float64)
    n_events = max(1, int(rng.poisson(rate_hz * n / SAMPLE_RATE)))
    for _ in range(n_events):
        start = int(rng.integers(0, max(n - 1, 1)))
        # Direct blast: 2-12 ms decay. Tail: 30-250 ms of room/terrain reverb.
        tau_direct = float(rng.uniform(0.002, 0.012)) * SAMPLE_RATE
        tau_tail = float(rng.uniform(0.03, 0.25)) * SAMPLE_RATE
        length = min(int(6 * tau_tail), n - start)
        if length <= 1:
            continue
        k = np.arange(length, dtype=np.float64)
        env = np.exp(-k / tau_direct) + 0.25 * np.exp(-k / tau_tail)
        # Blast energy is broadband but tilted low; the tail is darker still.
        exc = colored_noise(length, exponent=float(rng.uniform(0.3, 1.0)), rng=rng)
        out[start: start + length] += float(rng.uniform(0.6, 1.0)) * env * exc
    if _rms(out) < 1e-9:      # Poisson gave us nothing placeable
        out[n // 2] = 1.0
    return _normalize(out)


# --- Speech-like ---------------------------------------------------------

_VOWEL_FORMANTS = {            # F1, F2, F3 in Hz, adult-average
    "a": (730, 1090, 2440),
    "e": (530, 1840, 2480),
    "i": (270, 2290, 3010),
    "o": (570, 840, 2410),
    "u": (300, 870, 2240),
}


def _resonator(x: np.ndarray, f: np.ndarray, bw: float) -> np.ndarray:
    """Time-varying 2-pole resonator, applied sample by sample.

    Coefficients are recomputed per sample so formants can glide, which is what
    makes synthetic speech look like speech on a spectrogram rather than like a
    sequence of static tones.
    """
    n = len(x)
    y = np.zeros(n, dtype=np.float64)
    r = np.exp(-np.pi * bw / SAMPLE_RATE)
    theta = 2 * np.pi * f / SAMPLE_RATE
    a1 = 2.0 * r * np.cos(theta)
    a2 = -(r ** 2)
    gain = (1.0 - r) * np.sqrt(1.0 - 2.0 * r * np.cos(2 * theta) + r ** 2)
    y1 = y2 = 0.0
    for i in range(n):
        y0 = gain[i] * x[i] + a1[i] * y1 + a2 * y2
        y[i] = y0
        y2, y1 = y1, y0
    return y


def speech_like(n: int, rng: np.random.Generator) -> np.ndarray:
    """Source-filter synthetic speech: glottal pulses through gliding formants.

    This is a stand-in for a real speech corpus, which this environment cannot
    download. It reproduces the cues a VAD actually keys on -- harmonic
    structure at 85-255 Hz, formant peaks that move, ~4 Hz syllable modulation,
    and voiced/unvoiced alternation -- but it is not intelligible speech and no
    intelligibility metric should be computed against it.
    """
    t = np.arange(n, dtype=np.float64) / SAMPLE_RATE

    # F0 contour: a speaker-dependent mean with a slow declination and vibrato.
    f0_mean = float(rng.uniform(85.0, 255.0))
    decl = np.linspace(1.06, 0.94, n)
    jitter = 1.0 + 0.02 * np.sin(2 * np.pi * float(rng.uniform(3.0, 7.0)) * t + rng.uniform(0, 6.28))
    f0 = f0_mean * decl * jitter

    # Glottal source: band-limited pulse train (sawtooth-like, -12 dB/oct).
    phase = 2 * np.pi * np.cumsum(f0) / SAMPLE_RATE
    source = np.zeros(n, dtype=np.float64)
    for k in range(1, 40):
        if f0_mean * 1.1 * k >= SAMPLE_RATE / 2:
            break
        source += (1.0 / (k ** 1.2)) * np.sin(k * phase)

    # Formant trajectory: glide between two vowels over the clip.
    v1, v2 = rng.choice(list(_VOWEL_FORMANTS), size=2, replace=True)
    glide = 0.5 * (1.0 - np.cos(2 * np.pi * np.linspace(0, float(rng.uniform(0.6, 2.0)), n)))
    voiced = np.zeros(n, dtype=np.float64)
    for i, bw in enumerate((60.0, 90.0, 140.0)):
        f_track = _VOWEL_FORMANTS[v1][i] + glide * (_VOWEL_FORMANTS[v2][i] - _VOWEL_FORMANTS[v1][i])
        voiced += _resonator(source, f_track, bw) / (i + 1)

    # Fricative energy: high-passed noise, present throughout at low level.
    fric = colored_noise(n, exponent=-0.5, rng=rng)

    # Syllable-rate envelope with real pauses -- a VAD that never sees silence
    # learns nothing.
    syl_hz = float(rng.uniform(2.5, 6.0))
    env = 0.5 * (1.0 - np.cos(2 * np.pi * syl_hz * t + rng.uniform(0, 6.28)))
    env = env ** 1.5
    n_pauses = int(rng.integers(0, 3))
    for _ in range(n_pauses):
        p_start = int(rng.integers(0, max(n - 1, 1)))
        p_len = int(float(rng.uniform(0.1, 0.35)) * SAMPLE_RATE)
        env[p_start: p_start + p_len] = 0.0

    # Voicing gate: unvoiced stretches get fricative energy instead of pulses.
    voicing = (0.5 * (1.0 - np.cos(2 * np.pi * syl_hz * t + 0.8)) > 0.35).astype(np.float64)
    mixed = voicing * _normalize(voiced) + (1.0 - voicing) * 0.3 * fric
    return _normalize(mixed * env)


STATIONARY_SOURCES = (engine_hum, machinery_hum)
NON_STATIONARY_SOURCES = (engine_rev, vehicle_passby, wind_gust)
IMPULSIVE_SOURCES = (impulse_burst,)
