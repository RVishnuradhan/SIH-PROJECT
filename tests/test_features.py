import numpy as np

from anc.config import DEFAULT_FEATURES as CFG, SAMPLE_RATE
from anc.features import (
    frame_signal, hz_to_mel, log_mel, mel_filterbank, mel_filterbank_as_c_array, mel_to_hz,
)


def test_mel_scale_round_trips():
    f = np.array([0.0, 100.0, 1000.0, 7999.0])
    assert np.allclose(mel_to_hz(hz_to_mel(f)), f, atol=1e-6)


def test_context_window_gives_exactly_context_frames():
    x = np.zeros(CFG.context_samples, dtype=np.float32)
    assert frame_signal(x).shape == (CFG.context_frames, CFG.win_length)
    assert log_mel(x).shape == (CFG.context_frames, CFG.n_mels)


def test_too_short_signal_gives_no_frames():
    assert frame_signal(np.zeros(CFG.win_length - 1)).shape[0] == 0


def test_filterbank_covers_every_band():
    fb = mel_filterbank()
    assert fb.shape == (CFG.n_mels, CFG.n_fft // 2 + 1)
    assert (fb.sum(axis=1) > 0).all(), "a mel band has no FFT bins -- n_fft too small for n_mels"


def test_tone_peaks_in_the_right_band():
    for freq in (150.0, 1000.0, 4000.0):
        t = np.arange(SAMPLE_RATE) / SAMPLE_RATE
        lm = log_mel(np.sin(2 * np.pi * freq * t).astype(np.float32))
        peak_band = int(lm.mean(axis=0).argmax())
        edges = mel_to_hz(np.linspace(hz_to_mel(CFG.fmin), hz_to_mel(CFG.fmax), CFG.n_mels + 2))
        assert edges[peak_band] <= freq <= edges[peak_band + 2], (freq, peak_band)


def test_absolute_level_is_preserved():
    # Features must NOT be peak-normalised per clip: a louder copy of the same
    # signal has to produce larger values, or the model cannot see level.
    rng = np.random.default_rng(0)
    x = rng.standard_normal(CFG.context_samples).astype(np.float32) * 0.01
    assert log_mel(10 * x).mean() > log_mel(x).mean() + 15.0


def test_c_array_export_is_well_formed():
    src = mel_filterbank_as_c_array()
    assert "mel_fb_start[40]" in src and "mel_fb_len[40]" in src
    assert src.count("{") == src.count("}") == 3
