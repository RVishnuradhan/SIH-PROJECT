import numpy as np
import torch

from anc.denoiser import BANDS, N_BANDS, DenoiseNet, denoise, gains_to_bins, ideal_gains
from anc.postfilter import stft


def test_bands_cover_every_bin_and_partition_unity():
    assert BANDS.shape == (N_BANDS, 129)
    assert np.allclose(BANDS.sum(axis=0), 1.0)          # gains spread back without bumps
    assert ((BANDS > 0.01).sum(axis=1) >= 1).all()      # no empty band (the 8 kHz edge case)


def test_ideal_gains_are_one_for_clean_and_small_for_noise():
    rng = np.random.default_rng(0)
    s = rng.standard_normal(16000)
    g_clean = ideal_gains(stft(s), stft(s))
    assert np.allclose(g_clean, 1.0, atol=1e-4)
    n = 10 * rng.standard_normal(16000)
    assert ideal_gains(stft(s), stft(s + n)).mean() < 0.2


def test_uniform_gain_passes_signal_unchanged():
    g = np.full((5, N_BANDS), 0.5, np.float32)
    assert np.allclose(gains_to_bins(g), 0.5)


def test_denoise_runs_and_respects_floor():
    m = DenoiseNet()
    x = np.random.default_rng(1).standard_normal(8000) * 0.01
    y, G = denoise(m, x, floor_db=-30)
    assert y.shape == x.shape and np.isfinite(y).all()
    assert G.min() >= 10 ** (-30 / 20) - 1e-9 and G.max() <= 1.0 + 1e-6


def test_streaming_matches_whole_sequence():
    # The device runs one frame at a time, carrying the GRU state: that must
    # give exactly what the whole-sequence call gives.
    m = DenoiseNet().eval()
    f = torch.randn(1, 20, N_BANDS)
    whole, _ = m(f)
    state, parts = None, []
    for t in range(20):
        g, state = m(f[:, t:t + 1], state)
        parts.append(g)
    assert torch.allclose(whole, torch.cat(parts, 1), atol=1e-6)


def test_level_rule_learns_how_much_voice_reaches_the_outward_mic():
    # Voice only, almost as loud at the outward mic (as in the team's
    # fan_voice_close recording). A rule assuming little leak cuts the voice;
    # once the leak is learned, the voice must pass.
    from anc.denoiser import level_rule_gains
    rng = np.random.default_rng(3)
    s = rng.standard_normal(12 * 16000)            # it learns over ~4 s of talking
    X1, X2 = stft(s), stft(0.85 * s)
    talking = np.full((len(X1), N_BANDS), 0.9)
    G = level_rule_gains(X1, X2, talking)
    assert G[:5].mean() < 0.5                        # before learning: voice mistaken for noise
    assert G[-50:].mean() > 0.8                      # after: voice kept
    quiet = np.full((len(X1), N_BANDS), 0.1)         # network never sure it hears voice:
    assert level_rule_gains(X1, X2, quiet)[-50:].mean() < 0.5   # nothing learned
