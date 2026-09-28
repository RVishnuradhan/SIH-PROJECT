"""The speaker level stage (firmware/anc_unit/main/speaker_level.h) must never
clip, must still boost quiet sound, and must remove the mics' DC offset.

Firmware up to 0.6.1 multiplied by a fixed 8 instead; on the team's gunfire
recording that clipped 5-13% of the samples and the speaker sounded blurred.
"""
import shutil
import subprocess
from pathlib import Path

import numpy as np
import pytest
import soundfile as sf

ROOT = Path(__file__).resolve().parents[1]
MAIN = ROOT / "firmware/anc_unit/main"
CC = shutil.which("gcc") or shutil.which("cc")
pytestmark = pytest.mark.skipif(CC is None, reason="no C compiler")
FS = 16000
GAIN_MAX, CEILING, RELEASE_S = 8.0, 0.5, 0.3      # as in main.c

HARNESS = r"""
#include <stdio.h>
#include <stdlib.h>
#include "speaker_level.h"
int main(int argc, char **argv)
{
    if (argc != 4) return 2;
    speaker_level_t s;
    speaker_level_init(&s, atof(argv[1]), atof(argv[2]), atof(argv[3]), 16000.0f);
    float x;
    while (fread(&x, sizeof x, 1, stdin) == 1) {
        float y = speaker_level_step(&s, x);
        fwrite(&y, sizeof y, 1, stdout);
    }
    return 0;
}
"""


@pytest.fixture(scope="module")
def level(tmp_path_factory):
    d = tmp_path_factory.mktemp("spk")
    (d / "h.c").write_text(HARNESS)
    exe = d / "spk"
    subprocess.run([CC, "-O2", "-std=c11", "-Wall", "-Wextra", "-Werror", f"-I{MAIN}",
                    str(d / "h.c"), "-lm", "-o", str(exe)], check=True)

    def run(x):
        r = subprocess.run([str(exe), str(GAIN_MAX), str(CEILING), str(RELEASE_S)],
                           input=np.asarray(x, np.float32).tobytes(), capture_output=True, check=True)
        return np.frombuffer(r.stdout, np.float32).astype(np.float64)
    return run


@pytest.mark.parametrize("name", ["device_gunfire_cleaned.wav", "fan_voice_close.wav",
                                  "engine_voice_close.wav"])
def test_real_recordings_never_clip(level, name):
    path = ROOT / "data/raw_team" / name
    if not path.exists():
        pytest.skip("team recording not present")
    x, _ = sf.read(path, dtype="float32")
    mic1 = x[:, 0]
    assert np.mean(np.abs(mic1 * GAIN_MAX) > 1) > 0.01        # the old fixed gain clipped
    y = level(mic1)
    assert np.max(np.abs(y)) <= CEILING + 1e-6


def test_quiet_sound_gets_the_full_boost(level):
    t = np.arange(FS) / FS
    x = 0.01 * np.sin(2 * np.pi * 300 * t)                  # -43 dBFS peak
    y = level(x)
    tail = slice(FS // 2, None)
    assert np.max(np.abs(y[tail])) / np.max(np.abs(x[tail])) == pytest.approx(GAIN_MAX, rel=0.02)


def test_gain_comes_back_after_a_bang(level):
    t = np.arange(2 * FS) / FS
    x = 0.01 * np.sin(2 * np.pi * 300 * t)
    x[FS // 2:FS // 2 + 80] += 0.9                           # 5 ms gunshot
    y = level(x)
    assert np.max(np.abs(y)) <= CEILING + 1e-6
    late = slice(FS + FS // 2, None)                         # 1 s after the bang
    assert np.max(np.abs(y[late])) / np.max(np.abs(x[late])) > 0.9 * GAIN_MAX


def test_dc_offset_is_removed(level):
    t = np.arange(FS) / FS
    x = 0.05 + 0.01 * np.sin(2 * np.pi * 300 * t)          # mic DC offset + quiet voice
    y = level(x)
    tail = y[FS // 2:]
    assert abs(np.mean(tail)) < 0.01 * np.max(np.abs(tail))
    assert np.max(np.abs(tail)) > 0.9 * GAIN_MAX * 0.01     # offset no longer eats the headroom
