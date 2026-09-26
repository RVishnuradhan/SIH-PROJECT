#!/usr/bin/env python3
"""Export the trained noise suppressor for the ESP32.

    python tools/export_denoiser.py runs/denoiser/denoiser.pt

Writes firmware/anc_unit/main/denoiser.bin (int8 weights, ~128 KB), which the
firmware build links in. Rebuild and flash the firmware afterwards.
"""
from __future__ import annotations

import argparse
import sys
from pathlib import Path

import numpy as np

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "src"))
from anc.denoiser import denoise, dequantized, export_blob, load  # noqa: E402


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("model", type=Path)
    ap.add_argument("--out", type=Path, default=ROOT / "firmware/anc_unit/main/denoiser.bin")
    a = ap.parse_args()
    m = load(a.model)
    blob = export_blob(m)
    a.out.write_bytes(blob)

    # How much the int8 rounding changes the output, on a test signal.
    x = np.random.default_rng(0).standard_normal(3 * 16000) * 0.01
    full, _ = denoise(m, x)
    q, _ = denoise(dequantized(m), x)
    err = 10 * np.log10(np.sum(full ** 2) / np.sum((full - q) ** 2))
    n = sum(p.numel() for p in m.parameters())
    print(f"{a.out}: {len(blob)} bytes, {n} weights; int8 rounding changes the output by {err:.0f} dB below the signal")


if __name__ == "__main__":
    main()
