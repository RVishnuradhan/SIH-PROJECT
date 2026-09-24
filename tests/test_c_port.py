"""The C canceller (firmware/anc_unit/components/anc_core) must behave exactly
like the Python reference (anc.nlms.GatedCanceller + anc.loop).

Built twice with the host C compiler:
  double -- must match Python to ~1e-9, i.e. the same algorithm step for step;
  float  -- what the ESP32 runs; must give the same output SNR within 0.1 dB.
"""
import shutil
import subprocess
from pathlib import Path

import numpy as np
import pytest

from anc import synth
from anc.loop import (BLOCK, level_ratio_decisions, oracle_decisions, phrased_scene, run,
                      score)

ROOT = Path(__file__).resolve().parents[1]
CORE = ROOT / "firmware/anc_unit/components/anc_core"
CC = shutil.which("gcc") or shutil.which("cc")
pytestmark = pytest.mark.skipif(CC is None, reason="no C compiler")


@pytest.fixture(scope="module")
def binaries(tmp_path_factory):
    d = tmp_path_factory.mktemp("anc_c")
    out = {}
    for real in ("double", "float"):
        exe = d / f"anc_host_{real}"
        subprocess.run([CC, "-O2", "-std=c11", "-Wall", "-Wextra", "-Werror", f"-DANC_REAL={real}",
                        f"-I{CORE / 'include'}", str(CORE / "anc_core.c"),
                        str(CORE / "host/anc_host.c"), "-lm", "-o", str(exe)], check=True)
        out[real] = exe
    return out


def gate_bytes(decisions, n):
    """Per-block gate in the harness format, on the same schedule as anc.loop.run."""
    g = np.full(n // BLOCK, 2, np.uint8)
    di = 0
    for b in range(n // BLOCK):
        k, latest = b * BLOCK, None
        while di < len(decisions) and decisions[di][0] <= k:
            latest = decisions[di][1]
            di += 1
        if latest is not None:
            g[b] = 1 if latest else 0
    return g


def run_c(exe, sc, gate, tmp_path):
    n = len(sc.primary) // BLOCK * BLOCK
    (tmp_path / "p.f64").write_bytes(sc.primary[:n].astype(np.float64).tobytes())
    (tmp_path / "r.f64").write_bytes(sc.reference[:n].astype(np.float64).tobytes())
    if isinstance(gate, str):
        gate_arg = gate
    else:
        gate_arg = str(tmp_path / "g.u8")
        (tmp_path / "g.u8").write_bytes(gate_bytes(gate, n).tobytes())
    subprocess.run([str(exe), str(n), str(tmp_path / "p.f64"), str(tmp_path / "r.f64"),
                    gate_arg, str(tmp_path / "o.f64")], check=True, capture_output=True)
    return np.fromfile(tmp_path / "o.f64", dtype=np.float64)


@pytest.mark.parametrize("noise", [synth.engine_hum, synth.vehicle_passby, synth.wind_gust],
                         ids=lambda f: f.__name__)
def test_c_double_matches_python_exactly(binaries, tmp_path, noise):
    sc = phrased_scene(123, noise, seconds=5.0)
    dec = oracle_decisions(sc)
    py = run(sc, dec).astype(np.float64)
    c = run_c(binaries["double"], sc, dec, tmp_path)
    scale = np.max(np.abs(py))
    # Python rounds its output to float32; that is the only difference allowed.
    assert np.max(np.abs(c - py)) < 1e-6 * scale


def test_c_float_gives_the_same_result_as_python(binaries, tmp_path):
    for seed, noise in [(7, synth.engine_rev), (8, synth.vehicle_passby)]:
        sc = phrased_scene(seed, noise, seconds=6.0)
        dec = oracle_decisions(sc)
        py = score(sc, run(sc, dec))
        c = score(sc, run_c(binaries["float"], sc, dec, tmp_path).astype(np.float32))
        assert abs(py - c) < 0.1, (py, c)


def test_c_vad_matches_python_level_ratio_detector(binaries, tmp_path):
    # C feeds its detector after each block and applies the decision to the
    # next block -- the same timing anc.loop.run gives the Python detector.
    sc = phrased_scene(321, synth.engine_hum, seconds=6.0)
    py = run(sc, level_ratio_decisions(sc)).astype(np.float64)
    c = run_c(binaries["double"], sc, "vad", tmp_path)
    assert np.max(np.abs(c - py)) < 1e-6 * np.max(np.abs(py))
