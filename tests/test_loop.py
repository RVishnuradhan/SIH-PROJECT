import numpy as np

from anc import synth
from anc.loop import oracle_decisions, onset_lags_ms, phrased_scene, run, score


def test_oracle_detector_beats_no_detector_in_the_loop():
    sc = phrased_scene(11, synth.vehicle_passby, seconds=6.0)
    none = score(sc, run(sc, None))
    oracle = score(sc, run(sc, oracle_decisions(sc)))
    assert oracle > none + 5, (none, oracle)


def test_decisions_are_applied_only_once_available():
    # A detector that always says speech from 1 s onward must leave the
    # filter adapting (and so converging) for the first second.
    sc = phrased_scene(12, synth.engine_hum, seconds=3.0)
    late = [(16000, True)]
    out = run(sc, late)
    noise_only = slice(4000, 16000)            # before the first word at 1.5 s
    assert np.mean(out[noise_only] ** 2) < 0.1 * np.mean(sc.primary[noise_only] ** 2)


def test_onset_lag_measures_first_positive_after_onset():
    sc = phrased_scene(13, synth.engine_hum, seconds=4.0)
    onset = int(np.flatnonzero(sc.active)[0])
    lags = onset_lags_ms(sc, [(onset + 800, True)])
    assert lags[0] == 50.0


def test_level_ratio_detector_flags_mouth_mic_speech_and_holds():
    from anc.loop import LoopScene, level_ratio_decisions
    n = 16000
    rng = np.random.default_rng(0)
    noise = rng.standard_normal(n).astype(np.float32) * 0.01
    primary, reference = noise.copy(), noise.copy()
    primary[8000:9600] += rng.standard_normal(1600).astype(np.float32) * 0.05   # 100 ms "speech"
    sc = LoopScene(primary, reference, np.zeros(n, np.float32), np.zeros(n, bool), 0)
    dec = dict(level_ratio_decisions(sc, threshold_db=1.5))
    assert not dec[4000]                  # noise alone: equal at both mics
    assert dec[9600]                      # speech louder at the mouth mic
    assert dec[9600 + 2400]               # still held 150 ms later
    assert not dec[9600 + 4000]           # released after the hold
