import numpy as np
import pytest

from anc import synth
from anc.config import SAMPLE_RATE

N = SAMPLE_RATE // 2
ALL = [synth.engine_hum, synth.machinery_hum, synth.engine_rev, synth.vehicle_passby,
       synth.wind_gust, synth.impulse_burst, synth.siren, synth.helicopter_rotor,
       synth.drone_propellers, synth.tracked_vehicle, synth.artillery, synth.speech_like]


def _crest(x):
    return float(np.abs(x).max() / np.sqrt(np.mean(x ** 2)))


@pytest.mark.parametrize("fn", ALL, ids=lambda f: f.__name__)
def test_generator_contract(fn):
    x = fn(N, np.random.default_rng(1))
    assert x.dtype == np.float32 and x.shape == (N,)
    assert np.isfinite(x).all()
    assert np.sqrt(np.mean(x ** 2)) == pytest.approx(1.0, rel=1e-3)


@pytest.mark.parametrize("fn", ALL, ids=lambda f: f.__name__)
def test_generators_are_deterministic_given_a_seed(fn):
    a = fn(N, np.random.default_rng(7))
    b = fn(N, np.random.default_rng(7))
    assert np.array_equal(a, b)


def test_impulsive_is_far_peakier_than_stationary():
    # Crest factor is the physical property that separates the classes; if a
    # change to the generators erodes this gap, the labels stop meaning much.
    rng = np.random.default_rng(3)
    imp = np.median([_crest(synth.impulse_burst(N, rng)) for _ in range(10)])
    sta = np.median([_crest(synth.engine_hum(N, rng)) for _ in range(10)])
    assert imp > 2.5 * sta


def test_engine_energy_is_low_frequency():
    x = synth.engine_hum(SAMPLE_RATE, np.random.default_rng(4))
    spec = np.abs(np.fft.rfft(x)) ** 2
    freqs = np.fft.rfftfreq(len(x), 1 / SAMPLE_RATE)
    assert spec[freqs < 1000].sum() / spec.sum() > 0.8


def _band_share(x, lo, hi):
    spec = np.abs(np.fft.rfft(x)) ** 2
    f = np.fft.rfftfreq(len(x), 1 / SAMPLE_RATE)
    return spec[(f >= lo) & (f < hi)].sum() / spec.sum()


def test_siren_is_a_narrow_tone_in_the_speech_band():
    x = synth.siren(SAMPLE_RATE, np.random.default_rng(5))
    assert _band_share(x, 300, 4000) > 0.9


def test_artillery_is_mostly_below_200_hz_and_helicopter_is_thumpy():
    art = synth.artillery(2 * SAMPLE_RATE, np.random.default_rng(6))
    assert _band_share(art, 0, 200) > 0.6
    heli = np.median([_crest(synth.helicopter_rotor(N, np.random.default_rng(i))) for i in range(8)])
    eng = np.median([_crest(synth.engine_hum(N, np.random.default_rng(i))) for i in range(8)])
    assert heli > 1.3 * eng


def test_drone_sits_in_the_hundreds_of_hertz():
    x = synth.drone_propellers(SAMPLE_RATE, np.random.default_rng(8))
    assert _band_share(x, 150, 6000) > 0.9
