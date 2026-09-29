import numpy as np

from anc import synth
from anc.postfilter import FRAME, PostfilterParams, apply_gains, istft, stft, suppress


def test_stft_round_trip_is_transparent():
    rng = np.random.default_rng(0)
    x = rng.standard_normal(16000)
    y = istft(stft(x), len(x))
    core = slice(FRAME, len(x) - FRAME)          # edges lack full overlap
    assert np.allclose(y[core], x[core], atol=1e-9)


def test_removes_steady_noise_and_keeps_speech():
    rng = np.random.default_rng(1)
    n = 5 * 16000
    noise = 0.05 * synth.colored_noise(n, 0.8, rng)
    s = np.zeros(n)
    act = np.zeros(n, bool)
    s[16000:40000] = 0.2 * synth.speech_like(24000, rng)
    act[16000:40000] = True
    _, G = suppress(s + noise, act, PostfilterParams(floor_db=-15))
    seg = slice(2 * 16000, 4 * 16000)
    nr = 10 * np.log10(np.mean(noise[seg] ** 2) / np.mean(apply_gains(noise, G)[seg] ** 2))
    sd = 10 * np.log10(np.mean(s[seg] ** 2) / np.mean((apply_gains(s, G)[seg] - s[seg]) ** 2))
    assert nr > 5, nr            # noise turned down
    assert sd > 12, sd           # speech kept close to the original


def test_gain_never_below_floor():
    rng = np.random.default_rng(2)
    x = rng.standard_normal(16000)
    _, G = suppress(x, np.zeros(16000, bool), PostfilterParams(floor_db=-15))
    assert G.min() >= 10 ** (-15 / 20) - 1e-12 and G.max() <= 1.0
