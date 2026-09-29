#!/usr/bin/env python3
"""Build training / validation sets for the neural noise suppressor.

    python tools/build_denoise_set.py --out data/sets/denoise_train.npz --split train --n 6000
    python tools/build_denoise_set.py --out data/sets/denoise_val.npz   --split val   --n 500

Each example is 3 s: clean speech (DNS clean, close-talk, dry) plus noise from
DNS noise clips, the synthetic defence-noise generators (engines, wind,
gunfire-like impulses) and any real noise-only recordings in data/real_noise/.
Noise gets random room reverb; everything gets the INMP441's 60 Hz roll-off.
Clean and noise files are split by index so validation uses speakers and
noises the network never trained on.
"""
from __future__ import annotations

import os
for _v in ("OMP_NUM_THREADS", "OPENBLAS_NUM_THREADS", "MKL_NUM_THREADS"):
    os.environ.setdefault(_v, "1")

import argparse  # noqa: E402
import multiprocessing as mp  # noqa: E402
import sys  # noqa: E402
from pathlib import Path  # noqa: E402

import numpy as np  # noqa: E402
import soundfile as sf  # noqa: E402
from scipy.signal import fftconvolve, sosfilt  # noqa: E402

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "src"))
from anc import synth  # noqa: E402
from anc.config import SAMPLE_RATE  # noqa: E402
from anc.denoiser import HIGHPASS_SOS, features, features2, ideal_gains  # noqa: E402
from anc.postfilter import stft  # noqa: E402

SECONDS = 3.0
N = int(SECONDS * SAMPLE_RATE)
HPF = HIGHPASS_SOS            # the device applies the same filter to its input
SYNTH = [synth.engine_hum, synth.machinery_hum, synth.engine_rev, synth.vehicle_passby,
         synth.wind_gust, synth.impulse_burst, synth.impulse_burst]   # impulses twice: gunfire matters

_G: dict = {}


def _init(clean, noise, real, mics=1):
    _G.update(clean=clean, noise=noise, real=real, mics=mics)


def _crop(path_or_arr, rng, n=N):
    x = path_or_arr if isinstance(path_or_arr, np.ndarray) else sf.read(path_or_arr, dtype="float32", always_2d=True)[0][:, 0]
    if len(x) < n:
        x = np.tile(x, int(np.ceil(n / max(len(x), 1))) + 1)
    s = int(rng.integers(0, len(x) - n + 1))
    return x[s:s + n].astype(np.float64)


def _rir(rng, rt60=None):
    rt60 = rng.uniform(0.15, 0.6) if rt60 is None else rt60
    L = int(rt60 * SAMPLE_RATE)
    h = rng.standard_normal(L) * np.exp(-6.9 * np.arange(L) / L)
    h[0] = 1.0 + rng.uniform(0, 2)       # direct path dominant
    return h / np.sqrt(np.sum(h ** 2))


def _rms(x):
    return float(np.sqrt(np.mean(x ** 2)) + 1e-12)


def make_example(seed: int):
    if _G.get("mics", 1) == 2:
        return make_example2(seed)
    rng = np.random.default_rng(seed)
    clean, noise, real = _G["clean"], _G["noise"], _G["real"]

    # Speech: skip near-silent crops; 8% of examples are noise-only.
    s = np.zeros(N)
    if rng.random() > 0.08:
        for _ in range(10):
            s = _crop(clean[int(rng.integers(len(clean)))], rng)
            if _rms(s) > 1e-3:
                break

    # Noise: one or two sources; 4% of examples are clean speech only.
    n = np.zeros(N)
    if rng.random() > 0.04:
        for _ in range(1 if rng.random() < 0.7 else 2):
            u = rng.random()
            if u < 0.6 or not (real or SYNTH):
                src = _crop(noise[int(rng.integers(len(noise)))], rng)
            elif u < 0.85 or not real:
                src = SYNTH[int(rng.integers(len(SYNTH)))](N, rng).astype(np.float64)
            else:
                pair = real[int(rng.integers(len(real)))]
                src = _crop(pair[:, int(rng.integers(pair.shape[1]))], rng)
            if rng.random() < 0.5:
                src = fftconvolve(src, _rir(rng))[:N]
            n += src / _rms(src) * 10 ** (rng.uniform(-6, 0) / 20)

    s, n = sosfilt(HPF, s), sosfilt(HPF, n)
    if _rms(s) > 1e-6 and _rms(n) > 1e-6:
        n *= _rms(s) / _rms(n) / 10 ** (rng.uniform(-5, 20) / 20)
    x = s + n
    # Wide level range: the board sees -60 dBFS (far, quiet) to -10 (shouting
    # into the boom mic); a narrower range made the model level-dependent.
    g = 10 ** (rng.uniform(-60, -10) / 20) / _rms(x)
    g = min(g, 0.95 / (np.max(np.abs(x)) + 1e-12))
    s, x = s * g, x * g
    X, S = stft(x), stft(s)
    return features(X).astype(np.float16), ideal_gains(S, X).astype(np.float16)


def _noise_source(rng):
    """One noise source signal, as in make_example."""
    noise = _G["noise"]
    u = rng.random()
    if u < 0.65 or not SYNTH:
        return _crop(noise[int(rng.integers(len(noise)))], rng)
    return SYNTH[int(rng.integers(len(SYNTH)))](N, rng).astype(np.float64)


def _two_mic_noise(rng):
    """The same noise as heard by the mouth mic and the outward mic.

    Real pairs recorded on the board when available; otherwise one source
    through two rooms paths. Indoors the paths share little beyond the direct
    sound (the board measured coherence 0.1-0.7), outdoors they are nearly
    the same sound, slightly delayed. The outward mic is usually louder."""
    real = _G["real"]
    if real and rng.random() < 0.15:
        pair = real[int(rng.integers(len(real)))]
        k = int(rng.integers(0, len(pair) - N + 1))
        return pair[k:k + N, 0].astype(np.float64), pair[k:k + N, 1].astype(np.float64)
    src = _noise_source(rng)
    if rng.random() < 0.3:                                   # outdoors: direct sound only
        d = int(rng.integers(0, 9))
        n1, n2 = src, np.concatenate([np.zeros(d), src[:N - d]])
    else:                                                    # room: shared decay, different echoes
        rt60 = rng.uniform(0.15, 0.6)
        n1, n2 = fftconvolve(src, _rir(rng, rt60))[:N], fftconvolve(src, _rir(rng, rt60))[:N]
    n2 = n2 * 10 ** (rng.uniform(-6, 12) / 20)               # outward mic louder, mostly
    return n1, n2


def make_scene2(seed: int, snr_db: float | None = None):
    """Two-mic scene waveforms (clean voice at the mouth mic, mouth mic, outward
    mic). `snr_db` fixes the input SNR at the mouth mic; the random stream is
    the same either way, so make_example2 does not change."""
    rng = np.random.default_rng(seed)
    clean = _G["clean"]
    s = np.zeros(N)
    if rng.random() > 0.08:
        for _ in range(10):
            s = _crop(clean[int(rng.integers(len(clean)))], rng)
            if _rms(s) > 1e-3:
                break
    # Voice at the outward mic: later, quieter, with a little of the room.
    d = int(rng.integers(2, 13))
    leak = np.zeros(d + 1); leak[d] = 1.0
    leak = fftconvolve(leak, _rir(rng, rng.uniform(0.1, 0.4)) * 0.3)
    leak[d] += 1.0
    s2 = fftconvolve(s, leak)[:N]
    s2 *= 10 ** (rng.uniform(-20, -5) / 20) * _rms(s) / (_rms(s2) + 1e-12) if _rms(s) > 1e-6 else 0.0

    n1, n2 = np.zeros(N), np.zeros(N)
    if rng.random() > 0.04:
        for _ in range(1 if rng.random() < 0.7 else 2):
            a, b = _two_mic_noise(rng)
            gain = 10 ** (rng.uniform(-6, 0) / 20) / _rms(a)
            n1 += a * gain; n2 += b * gain

    s, s2, n1, n2 = (sosfilt(HPF, v) for v in (s, s2, n1, n2))
    if _rms(s) > 1e-6 and _rms(n1) > 1e-6:
        snr = rng.uniform(-5, 20)
        k = _rms(s) / _rms(n1) / 10 ** ((snr if snr_db is None else snr_db) / 20)
        n1, n2 = n1 * k, n2 * k
    x1, x2 = s + n1, (s2 + n2) * 10 ** (rng.uniform(-2, 2) / 20)   # mic gain mismatch
    g = 10 ** (rng.uniform(-60, -10) / 20) / _rms(x1)
    g = min(g, 0.95 / (max(np.max(np.abs(x1)), np.max(np.abs(x2))) + 1e-12))
    s, x1, x2 = s * g, x1 * g, x2 * g
    hiss = 10 ** (rng.uniform(-85, -70) / 20)                      # mic self-noise
    x1 = x1 + hiss * rng.standard_normal(N)
    x2 = x2 + hiss * rng.standard_normal(N)
    return s, x1, x2


def make_example2(seed: int):
    """Two-mic example: features of both mics, target gains for the mouth mic."""
    s, x1, x2 = make_scene2(seed)
    X1, S = stft(x1), stft(s)
    return features2(X1, stft(x2)).astype(np.float16), ideal_gains(S, X1).astype(np.float16)


def file_lists(root: Path, split: str):
    clean = sorted((root / "dns/clean").glob("*.wav"))
    noise = sorted((root / "dns/noise").glob("*.wav"))
    real_files = sorted((root / "real_noise").glob("*.wav"))
    real = []
    for f in real_files:
        real.append(sf.read(f, dtype="float32", always_2d=True)[0])   # (samples, mics)
    kc, kn = int(len(clean) * 0.9), int(len(noise) * 0.9)
    if split == "train":
        return [str(p) for p in clean[:kc]], [str(p) for p in noise[:kn]], real
    return [str(p) for p in clean[kc:]], [str(p) for p in noise[kn:]], real


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--out", type=Path, required=True)
    ap.add_argument("--split", choices=("train", "val"), required=True)
    ap.add_argument("--n", type=int, default=6000)
    ap.add_argument("--data", type=Path, default=Path("data"))
    ap.add_argument("--workers", type=int, default=4)
    ap.add_argument("--mics", type=int, choices=(1, 2), default=1)
    a = ap.parse_args()
    clean, noise, real = file_lists(a.data, a.split)
    print(f"{a.split}: {len(clean)} clean files, {len(noise)} noise files, {len(real)} real noise recordings, {a.mics} mic(s)")
    base = 0 if a.split == "train" else 10_000_000
    with mp.Pool(a.workers, initializer=_init, initargs=(clean, noise, real, a.mics)) as pool:
        out = pool.map(make_example, range(base, base + a.n), chunksize=32)
    F = np.stack([o[0] for o in out]); G = np.stack([o[1] for o in out])
    a.out.parent.mkdir(parents=True, exist_ok=True)
    np.savez(a.out, features=F, gains=G)
    print(f"saved {a.out}: features {F.shape}, mean target gain {G.astype(np.float32).mean():.2f}")


if __name__ == "__main__":
    main()
