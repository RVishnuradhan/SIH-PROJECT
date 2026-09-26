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
from scipy.signal import butter, fftconvolve, sosfilt  # noqa: E402

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "src"))
from anc import synth  # noqa: E402
from anc.config import SAMPLE_RATE  # noqa: E402
from anc.denoiser import features, ideal_gains  # noqa: E402
from anc.postfilter import stft  # noqa: E402

SECONDS = 3.0
N = int(SECONDS * SAMPLE_RATE)
HPF = butter(1, 60, "highpass", fs=SAMPLE_RATE, output="sos")        # INMP441 roll-off
SYNTH = [synth.engine_hum, synth.machinery_hum, synth.engine_rev, synth.vehicle_passby,
         synth.wind_gust, synth.impulse_burst, synth.impulse_burst]   # impulses twice: gunfire matters

_G: dict = {}


def _init(clean, noise, real):
    _G.update(clean=clean, noise=noise, real=real)


def _crop(path_or_arr, rng, n=N):
    x = path_or_arr if isinstance(path_or_arr, np.ndarray) else sf.read(path_or_arr, dtype="float32", always_2d=True)[0][:, 0]
    if len(x) < n:
        x = np.tile(x, int(np.ceil(n / max(len(x), 1))) + 1)
    s = int(rng.integers(0, len(x) - n + 1))
    return x[s:s + n].astype(np.float64)


def _rir(rng):
    rt60 = rng.uniform(0.15, 0.6)
    L = int(rt60 * SAMPLE_RATE)
    h = rng.standard_normal(L) * np.exp(-6.9 * np.arange(L) / L)
    h[0] = 1.0 + rng.uniform(0, 2)       # direct path dominant
    return h / np.sqrt(np.sum(h ** 2))


def _rms(x):
    return float(np.sqrt(np.mean(x ** 2)) + 1e-12)


def make_example(seed: int):
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
                src = _crop(real[int(rng.integers(len(real)))], rng)
            if rng.random() < 0.5:
                src = fftconvolve(src, _rir(rng))[:N]
            n += src / _rms(src) * 10 ** (rng.uniform(-6, 0) / 20)

    s, n = sosfilt(HPF, s), sosfilt(HPF, n)
    if _rms(s) > 1e-6 and _rms(n) > 1e-6:
        n *= _rms(s) / _rms(n) / 10 ** (rng.uniform(-5, 20) / 20)
    x = s + n
    g = 10 ** (rng.uniform(-45, -15) / 20) / _rms(x)
    g = min(g, 0.95 / (np.max(np.abs(x)) + 1e-12))
    s, x = s * g, x * g
    X, S = stft(x), stft(s)
    return features(X).astype(np.float16), ideal_gains(S, X).astype(np.float16)


def file_lists(root: Path, split: str):
    clean = sorted((root / "dns/clean").glob("*.wav"))
    noise = sorted((root / "dns/noise").glob("*.wav"))
    real_files = sorted((root / "real_noise").glob("*.wav"))
    real = []
    for f in real_files:
        a = sf.read(f, dtype="float32", always_2d=True)[0]
        real += [a[:, c] for c in range(a.shape[1])]
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
    a = ap.parse_args()
    clean, noise, real = file_lists(a.data, a.split)
    print(f"{a.split}: {len(clean)} clean files, {len(noise)} noise files, {len(real)} real noise channels")
    base = 0 if a.split == "train" else 10_000_000
    with mp.Pool(a.workers, initializer=_init, initargs=(clean, noise, real)) as pool:
        out = pool.map(make_example, range(base, base + a.n), chunksize=32)
    F = np.stack([o[0] for o in out]); G = np.stack([o[1] for o in out])
    a.out.parent.mkdir(parents=True, exist_ok=True)
    np.savez(a.out, features=F, gains=G)
    print(f"saved {a.out}: features {F.shape}, mean target gain {G.astype(np.float32).mean():.2f}")


if __name__ == "__main__":
    main()
