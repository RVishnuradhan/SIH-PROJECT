"""End-to-end test of tools/record.py against a simulated device on a pty."""
import json
import os
import subprocess
import sys
import threading
import time
from pathlib import Path

import numpy as np
import pytest
import soundfile as sf

from anc.link import BLOCK_FRAMES, encode_block

pytestmark = pytest.mark.skipif(os.name != "posix", reason="needs a pty")
ROOT = Path(__file__).resolve().parents[1]


class FakeUnit(threading.Thread):
    """Speaks the firmware protocol. Primary = 440 Hz tone, reference = 1 kHz.
    Drops block 5 to exercise gap handling."""

    def __init__(self, fd):
        super().__init__(daemon=True)
        self.fd, self.streaming, self.stop = fd, False, False

    def run(self):
        seq, t = 0, 0
        os.set_blocking(self.fd, False)
        while not self.stop:
            try:
                cmds = os.read(self.fd, 64)
            except BlockingIOError:
                cmds = b""
            except OSError:
                return
            for c in cmds:
                if c == ord("I") and not self.streaming:
                    os.write(self.fd, b"ANC fw=sim fs=16000 block=160 psram=8388608 monitor=mute "
                                      b"lvl_primary=-40.0 lvl_reference=-45.0\n")
                elif c == ord("R"):
                    self.streaming, seq = True, 0
                elif c == ord("S"):
                    self.streaming = False
            if self.streaming:
                n = np.arange(t, t + BLOCK_FRAMES) / 16000
                blk = np.stack([np.sin(2 * np.pi * 440 * n), np.sin(2 * np.pi * 1000 * n)], axis=1)
                if seq != 5:
                    try:
                        os.write(self.fd, encode_block(seq, 1 if seq > 5 else 0,
                                                       (blk * 0.1 * (1 << 23)).astype(np.int32)))
                    except BlockingIOError:
                        pass
                seq, t = seq + 1, t + BLOCK_FRAMES
                time.sleep(0.01)
            else:
                time.sleep(0.005)


def test_record_writes_aligned_24bit_stereo_wav(tmp_path):
    master, slave = os.openpty()
    import tty
    tty.setraw(slave)
    dev = FakeUnit(master)
    dev.start()
    try:
        r = subprocess.run(
            [sys.executable, str(ROOT / "tools/record.py"), "record", "--port", os.ttyname(slave),
             "--label", "impulsive", "speech", "--seconds", "1.0", "--out", str(tmp_path)],
            capture_output=True, text=True, timeout=30)
    finally:
        dev.stop = True
    assert r.returncode == 0, r.stderr

    wav = next(tmp_path.glob("*.wav"))
    meta = json.loads(wav.with_suffix(".json").read_text())
    info = sf.info(wav)
    assert info.channels == 2 and info.samplerate == 16000 and info.subtype == "PCM_24"
    assert meta["labels"] == ["impulsive", "speech"]
    assert meta["missing_blocks"] == 1          # the dropped block 5

    x, _ = sf.read(wav)
    # Channels land on the right sides: primary carries 440 Hz, reference 1 kHz.
    good = x[6 * BLOCK_FRAMES:]                 # skip the zero-filled gap
    freqs = np.fft.rfftfreq(len(good), 1 / 16000)
    assert abs(freqs[np.abs(np.fft.rfft(good[:, 0])).argmax()] - 440) < 5
    assert abs(freqs[np.abs(np.fft.rfft(good[:, 1])).argmax()] - 1000) < 5
    # The lost block is zero-filled, not skipped: block 5 is silent.
    assert not x[5 * BLOCK_FRAMES:6 * BLOCK_FRAMES].any()
