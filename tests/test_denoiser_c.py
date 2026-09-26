"""The C noise suppressor (firmware/anc_unit/components/anc_denoise) must give
what the Python network gives, and the int8 export must not change the sound.

Uses a randomly initialised network, so it does not need a trained model.
"""
import shutil
import subprocess
from pathlib import Path

import numpy as np
import pytest
import torch

from anc import synth
from anc.denoiser import DenoiseNet, denoise, dequantized, export_blob

ROOT = Path(__file__).resolve().parents[1]
DN = ROOT / "firmware/anc_unit/components/anc_denoise"
CC = shutil.which("gcc") or shutil.which("cc")
pytestmark = pytest.mark.skipif(CC is None, reason="no C compiler")
HOP = 128


@pytest.fixture(scope="module")
def host(tmp_path_factory):
    exe = tmp_path_factory.mktemp("dn") / "denoise_host"
    subprocess.run([CC, "-O2", "-std=c11", "-Wall", "-Wextra", "-Werror", f"-I{DN / 'include'}",
                    str(DN / "anc_denoise.c"), str(DN / "host/denoise_host.c"), "-lm", "-o", str(exe)],
                   check=True)
    return exe


@pytest.fixture(scope="module")
def model():
    torch.manual_seed(0)
    m = DenoiseNet()
    with torch.no_grad():                          # exercise the normalisation too
        m.in_mean.copy_(torch.linspace(-7, -5, 24))
        m.in_std.copy_(torch.linspace(0.8, 1.5, 24))
    return m.eval()


def signal(seconds=3.0):
    rng = np.random.default_rng(1)
    n = int(seconds * 16000)
    return 0.05 * synth.speech_like(n, rng) + 0.02 * synth.engine_hum(n, rng)


def run_c(host, blob, x, block, tmp_path):
    (tmp_path / "w.bin").write_bytes(blob)
    x.astype(np.float32).tofile(tmp_path / "in.f32")
    r = subprocess.run([str(host), str(tmp_path / "w.bin"), str(block), str(len(x)),
                        str(tmp_path / "in.f32"), str(tmp_path / "out.f32")],
                       capture_output=True, text=True, check=True)
    fields = dict(kv.split("=") for kv in r.stdout.split())
    return np.fromfile(tmp_path / "out.f32", np.float32).astype(np.float64), int(fields["latency"])


@pytest.mark.parametrize("block", [160, 128, 100])
def test_c_matches_python(host, model, tmp_path, block):
    x = signal()
    x = x[:len(x) // block * block]
    c, latency = run_c(host, export_blob(model), x, block, tmp_path)
    # The device starts with an empty frame, i.e. 128 zeros before the signal.
    ref, _ = denoise(dequantized(model), np.concatenate([np.zeros(HOP), x]))
    pad = latency - HOP                            # silence banked by the block adapter
    assert np.all(c[:pad] == 0)
    n_frames = 1 + (len(x) + HOP - 256) // HOP
    m = min(n_frames * HOP, len(x) - pad)
    err = c[pad:pad + m] - ref[:m]
    assert 10 * np.log10(np.sum(ref[:m] ** 2) / np.sum(err ** 2)) > 80


def test_latency_is_as_small_as_the_block_size_allows(host, model, tmp_path):
    x = signal(1.0)
    assert run_c(host, export_blob(model), x[:16000 // 160 * 160], 160, tmp_path)[1] == 224   # 14 ms
    assert run_c(host, export_blob(model), x[:16000 // 128 * 128], 128, tmp_path)[1] == 128   # 8 ms


def test_int8_weights_do_not_change_the_output(model):
    x = signal()
    full, _ = denoise(model, x)
    q, _ = denoise(dequantized(model), x)
    assert 10 * np.log10(np.sum(full ** 2) / np.sum((full - q) ** 2)) > 35


def test_rejects_a_damaged_blob(host, model, tmp_path):
    blob = export_blob(model)
    for bad in (b"XXXX" + blob[4:], blob[:-8], blob + b"\0\0\0\0"):
        (tmp_path / "w.bin").write_bytes(bad)
        np.zeros(160, np.float32).tofile(tmp_path / "in.f32")
        r = subprocess.run([str(host), str(tmp_path / "w.bin"), "160", "160",
                            str(tmp_path / "in.f32"), str(tmp_path / "out.f32")], capture_output=True)
        assert r.returncode == 3


def test_dc_offset_and_rumble_are_ignored(host, model, tmp_path):
    # The board's mics carry DC drift and breath puffs below 20 Hz; the
    # device's input high-pass must stop them from changing what comes out.
    x = signal()[:48000]
    t = np.arange(len(x)) / 16000
    wobble = 0.05 + 0.03 * np.sin(2 * np.pi * 3 * t)
    blob = export_blob(model)
    clean, _ = run_c(host, blob, x, 160, tmp_path)
    dirty, _ = run_c(host, blob, x + wobble, 160, tmp_path)
    tail = slice(8000, None)
    assert 10 * np.log10(np.sum(clean[tail] ** 2) / np.sum((dirty - clean)[tail] ** 2)) > 20
