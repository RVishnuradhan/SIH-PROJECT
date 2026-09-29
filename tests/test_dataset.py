import json

import numpy as np
import soundfile as sf

from anc.config import DEFAULT_FEATURES as CFG, SAMPLE_RATE
from anc.dataset import (IDX, N_LABELS, pack, recording_windows, synthetic_clip,
                         window_span)


def test_labels_are_zero_one_or_masked():
    for seed in range(10):
        L = synthetic_clip(seed).labels
        assert L.shape[1] == N_LABELS
        assert np.all(np.isnan(L) | (L == 0) | (L == 1))


def test_speech_label_follows_the_speech_switch():
    no = np.concatenate([synthetic_clip(s, p_speech=0.0).labels for s in range(5)])
    yes = np.concatenate([synthetic_clip(s, p_speech=1.0).labels for s in range(5)])
    assert np.nansum(no[:, IDX["speech"]]) == 0
    assert np.nanmean(yes[:, IDX["speech"]]) > 0.3


def test_features_are_two_mics_and_windows_fit():
    c = synthetic_clip(3)
    assert c.features.shape[0] == 2 and c.features.shape[2] == CFG.n_mels
    assert c.starts[-1] + CFG.context_frames <= c.features.shape[1]
    assert window_span(1) == (CFG.hop_length, CFG.hop_length + CFG.context_samples)


def test_pack_indexes_back_into_the_right_frames():
    clips = [synthetic_clip(s) for s in range(3)]
    d = pack(clips)
    w = len(clips[0].starts) + 4            # 5th window of the second clip
    f = d["window_frame"][w]
    got = d["features"][:, f:f + CFG.context_frames]
    s = clips[1].starts[4]
    assert np.array_equal(got, clips[1].features[:, s:s + CFG.context_frames])
    assert d["window_clip"][w] == 1


def test_recording_windows_use_sidecar_labels(tmp_path):
    rng = np.random.default_rng(0)
    n = 3 * SAMPLE_RATE
    x = 0.01 * rng.standard_normal((n, 2))
    x[n // 2: n // 2 + 800] *= 50          # one loud hit
    wav = tmp_path / "rec.wav"
    sf.write(wav, x, SAMPLE_RATE, subtype="PCM_24")
    wav.with_suffix(".json").write_text(json.dumps({"labels": ["stationary", "impulsive"]}))
    L = recording_windows(wav).labels
    assert np.all(L[:, IDX["stationary"]] == 1)
    assert np.all(L[:, IDX["non_stationary"]] == 0)
    assert np.all(L[:, IDX["speech"]] == 0)
    assert np.all(np.isnan(L[:, IDX["impulsive"]]) | (L[:, IDX["impulsive"]] == 1))
