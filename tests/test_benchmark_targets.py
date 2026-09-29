"""tools/benchmark_targets.py scores a two-mic scene against the clean voice.

Uses a randomly initialised network and synthetic sounds, so it needs neither
the trained model nor the DNS data; it checks the measurement itself.
"""
import importlib.util
from pathlib import Path

import numpy as np
import pytest
import torch

from anc import synth
from anc.denoiser import DenoiseNet

ROOT = Path(__file__).resolve().parents[1]
spec = importlib.util.spec_from_file_location("bench", ROOT / "tools/benchmark_targets.py")
bench = importlib.util.module_from_spec(spec)
spec.loader.exec_module(bench)


def scene():
    rng = np.random.default_rng(3)
    n = 3 * 16000
    voice = 0.05 * synth.speech_like(n, rng)
    noise = 0.02 * synth.engine_hum(n, rng)
    return voice, voice + noise, 0.3 * noise + 0.05 * voice


def test_score_scene_reports_all_metrics():
    torch.manual_seed(0)
    model = DenoiseNet(mics=2).eval()
    r = bench.score_scene(model, *scene())
    assert set(r) == {"in_snr_db", "snr_db", "stoi", "pesq", "stoi_in", "pesq_in"}
    assert 0.0 <= r["stoi"] <= 1.0 and 1.0 <= r["pesq"] <= 4.65
    assert r["in_snr_db"] == pytest.approx(10 * np.log10(0.05 ** 2 * 1 / (0.02 ** 2)), abs=8)


def test_perfect_output_scores_at_the_top():
    voice, _, _ = scene()
    assert bench.stoi(voice, voice, 16000) == pytest.approx(1.0, abs=1e-3)
    assert bench.pesq_wb(voice, voice) > 4.0


def test_summary_counts_scenes_meeting_the_targets():
    rows = [{"snr_db": 20, "stoi": 0.9, "pesq": 2.6, "stoi_in": 0.8, "pesq_in": 1.5, "in_snr_db": 5},
            {"snr_db": 10, "stoi": 0.9, "pesq": 2.0, "stoi_in": 0.8, "pesq_in": 1.5, "in_snr_db": 5}]
    t = bench.summarize({5: rows})["5"]
    assert (t["pass_snr_db"], t["pass_stoi"], t["pass_pesq"], t["pass_all"]) == (0.5, 1.0, 0.5, 0.5)
