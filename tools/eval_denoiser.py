#!/usr/bin/env python3
"""Evaluate the neural noise suppressor.

1. Held-out mixtures (speakers and noises never seen in training): because the
   clean speech and noise are known, the same gains are applied to each
   separately ("shadow filtering") to measure noise removed while talking,
   noise removed in pauses, and damage to the voice.
2. Real recordings from the board (primary mic): noise change in the pauses and
   voice change, plus a before/beep/after listening file.

    python tools/eval_denoiser.py runs/denoiser/denoiser.pt --real data/raw/*.wav
"""
from __future__ import annotations

import argparse
import importlib.util
import sys
from pathlib import Path

import numpy as np
import soundfile as sf
import torch
from scipy.ndimage import maximum_filter1d, uniform_filter1d

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "src"))
from anc.denoiser import denoise, highpass, load  # noqa: E402
from anc.postfilter import PostfilterParams, apply_gains, stft, suppress  # noqa: E402

spec = importlib.util.spec_from_file_location("bds", ROOT / "tools/build_denoise_set.py")
bds = importlib.util.module_from_spec(spec); spec.loader.exec_module(bds)

db = lambda e: 10 * np.log10(e + 1e-20)  # noqa: E731


@torch.no_grad()
def nn_gains(model, x, floor_db=-30.0):
    return denoise(model, x, floor_db, filtered=True)[1]     # the mixtures are pre-filtered


def heldout(model, n_examples=60, snrs=(-5, 0, 5, 10)):
    clean, noise, real = bds.file_lists(ROOT / "data", "val")
    bds._init(clean, noise, [])
    print(f"\nHeld-out mixtures ({n_examples} per SNR; unseen speakers and noises)")
    print(f"{'input SNR':>10} | {'method':22s} | noise while talking | noise in pauses | voice quality (higher = cleaner)")
    for snr in snrs:
        rows = {"neural (AI)": [], "old method (Wiener)": []}
        for k in range(n_examples):
            rng = np.random.default_rng(20_000_000 + 1000 * snr + k)
            s = bds._crop(clean[int(rng.integers(len(clean)))], rng)
            src = bds._crop(noise[int(rng.integers(len(noise)))], rng)
            s, nz = bds.sosfilt(bds.HPF, s), bds.sosfilt(bds.HPF, src)
            # speech in phrases: silence a few gaps so there are pauses to measure
            env = np.ones(len(s))
            for _ in range(3):
                a0 = int(rng.integers(0, len(s) - 8000)); env[a0:a0 + int(rng.integers(3000, 8000))] = 0
            s = s * uniform_filter1d(env, 400)
            nz *= bds._rms(s) / bds._rms(nz) / 10 ** (snr / 20)
            x = s + nz
            talk = uniform_filter1d(s ** 2, 400) > 0.05 * np.mean(s ** 2)
            for name in rows:
                if name.startswith("neural"):
                    G = nn_gains(model, x)
                else:
                    _, G = suppress(x, maximum_filter1d(talk, 2400), PostfilterParams())
                so, no = apply_gains(s, G), apply_gains(nz, G)
                seg = slice(4000, len(x) - 400)
                t, p = talk[seg], ~talk[seg]
                rows[name].append((db(np.mean(no[seg][t] ** 2)) - db(np.mean(nz[seg][t] ** 2)),
                                   db(np.mean(no[seg][p] ** 2)) - db(np.mean(nz[seg][p] ** 2)),
                                   db(np.mean(s[seg] ** 2)) - db(np.mean((so[seg] - s[seg]) ** 2))))
        for name, v in rows.items():
            v = np.array(v).mean(0)
            print(f"{snr:>8} dB | {name:22s} | {v[0]:+8.1f} dB         | {v[1]:+8.1f} dB     | {v[2]:6.1f} dB")


def real(model, paths, listen_dir: Path | None):
    print("\nReal recordings from the board (primary mic)")
    print(f"{'file':34s} | {'method':22s} | noise in pauses | voice")
    for p in paths:
        x, fs = sf.read(p, dtype="float64", always_2d=True)
        if np.mean(x[:, 0] == 0) > 0.5:
            continue
        # Score against the high-passed mic: removing the board's sub-60 Hz
        # rumble is wanted, and would otherwise count as lost voice.
        pri = highpass(x[:, 0])
        eg = db(uniform_filter1d(pri ** 2, 1600)); gaps = eg < np.percentile(eg, 25); voice = eg > np.percentile(eg, 70)
        e = db(uniform_filter1d(pri ** 2, 160)); flag = maximum_filter1d(e > np.percentile(e, 15) + 6, 2400)
        outs = {"neural (AI)": denoise(model, pri, filtered=True)[0], "old method (Wiener)": suppress(pri, flag)[0]}
        for name, y in outs.items():
            print(f"{Path(p).name[-34:]:34s} | {name:22s} | {db(np.mean(y[gaps]**2)) - db(np.mean(pri[gaps]**2)):+8.1f} dB     | "
                  f"{db(np.mean(y[voice]**2)) - db(np.mean(pri[voice]**2)):+5.1f} dB")
        if listen_dir:
            y = outs["neural (AI)"]
            # 8 s with as much talking AND as many pauses as possible, so the
            # listener hears both the voice and the noise between words.
            W = 8 * fs
            q = np.convolve((eg < np.percentile(eg, 30)).astype(float), np.ones(W), "valid")
            v = np.convolve((eg > np.percentile(eg, 60)).astype(float), np.ones(W), "valid")
            s0 = int(np.argmax(np.minimum(q, v)))
            beep = 0.15 * np.sin(2 * np.pi * 1000 * np.arange(int(0.25 * fs)) / fs); gap = np.zeros(int(0.5 * fs))
            out = np.concatenate([pri[s0:s0 + W], gap, beep, gap, y[s0:s0 + W]])
            listen_dir.mkdir(parents=True, exist_ok=True)
            sf.write(listen_dir / f"AB_AI_{Path(p).stem}.wav", out / np.abs(out).max() * 0.9, fs, subtype="PCM_16")


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("model", type=Path)
    ap.add_argument("--real", nargs="*", default=[])
    ap.add_argument("--listen-dir", type=Path)
    ap.add_argument("--n", type=int, default=60)
    a = ap.parse_args()
    torch.set_num_threads(2)
    m = load(a.model)
    heldout(m, a.n)
    if a.real:
        real(m, a.real, a.listen_dir)


if __name__ == "__main__":
    main()
