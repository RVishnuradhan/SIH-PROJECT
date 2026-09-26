#!/usr/bin/env python3
"""Record both INMP441s from the ANC unit over its native USB port.

Wiring check (prints mic levels once a second; talk into each mic):
    python tools/record.py levels --port COM5

Record 2 minutes of labelled audio:
    python tools/record.py record --port COM5 --label impulsive --seconds 120

Re-record a synthetic file (plays it through the laptop speaker while recording):
    python tools/record.py record --port COM5 --play data/playback/engine_000.wav

Each recording is a 24-bit stereo WAV (left = primary mic, right = reference mic)
plus a .json sidecar with the label and any lost blocks.
"""
from __future__ import annotations

import argparse
import json
import sys
import time
from datetime import datetime
from pathlib import Path

import numpy as np
import serial
import soundfile as sf

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "src"))
from anc.config import NOISE_CLASSES, SAMPLE_RATE  # noqa: E402
from anc.link import FULL_SCALE_24, FrameParser, assemble  # noqa: E402

LABELS = NOISE_CLASSES + ("speech", "silence")


def open_port(port: str) -> serial.Serial:
    ser = serial.Serial(port, baudrate=115200, timeout=0.05)  # baud is ignored on native USB
    ser.write(b"S")          # in case a previous run left it streaming
    time.sleep(0.3)
    ser.reset_input_buffer()
    return ser


def query_info(ser: serial.Serial) -> str:
    ser.reset_input_buffer()
    ser.write(b"I")
    deadline = time.time() + 1.0
    buf = b""
    while time.time() < deadline:
        buf += ser.read(512)
        if b"\n" in buf:
            for line in buf.split(b"\n"):
                if line.startswith(b"ANC "):
                    return line.decode(errors="replace")
    raise RuntimeError("no reply from device: wrong port, or firmware not flashed?")


def cmd_levels(args: argparse.Namespace) -> None:
    ser = open_port(args.port)
    print(query_info(ser))
    print("\nLevels in dBFS. Talk into one mic at a time; that mic should jump by 20+ dB.")
    print("-200 means all-zero data: check SD, BCLK and WS wiring.\n")
    try:
        while True:
            fields = dict(kv.split("=", 1) for kv in query_info(ser).split()[1:])
            line = (f"\r primary {float(fields['lvl_primary']):7.1f}   "
                    f"reference {float(fields['lvl_reference']):7.1f}   ")
            if "lvl_cleaned" in fields:           # firmware 0.2+: canceller running
                line += (f"cleaned {float(fields['lvl_cleaned']):7.1f}   speech {fields['speech']}   "
                         f"ratio {float(fields['ratio_db']):5.1f} dB   proc {fields['proc_us_max']} us   ")
            if fields.get("ai") == "1":           # firmware 0.3+: neural suppressor running
                line += f"ai {float(fields['lvl_ai']):7.1f}   ai_gain {fields['ai_gain']}   "
            print(line, end="", flush=True)
            time.sleep(1.0)
    except KeyboardInterrupt:
        print()


def cmd_record(args: argparse.Namespace) -> None:
    playback = None
    label = args.label
    if args.play:
        playback, pb_rate = sf.read(args.play, dtype="float32")
        if pb_rate != SAMPLE_RATE:
            sys.exit(f"{args.play}: sample rate {pb_rate}, expected {SAMPLE_RATE}")
        seconds = len(playback) / SAMPLE_RATE + 1.0
        sidecar = Path(args.play).with_suffix(".json")
        if label is None and sidecar.exists():
            label = json.loads(sidecar.read_text()).get("labels")
    else:
        seconds = args.seconds
    if label is None and args.cleaned:
        label = []                     # before/after tests are not training data
    if label is None:
        sys.exit("give --label, or --play a file that has a .json sidecar with labels")

    ser = open_port(args.port)
    info = query_info(ser)
    print(info)
    fields = dict(kv.split("=", 1) for kv in info.split()[1:] if "=" in kv)
    # Firmware 0.3+ reports how far the output lags the primary mic; 0.2 had
    # only the canceller's 16-sample delay.
    out_delay = int(fields.get("out_delay", 16))

    parser, blocks = FrameParser(), []
    ser.write(b"P" if args.cleaned else b"R")
    t0 = time.time()
    if playback is not None:
        import sounddevice as sd  # only needed for re-recording
        time.sleep(0.5)  # let the device start streaming before the sound starts
        sd.play(playback, SAMPLE_RATE)
    print(f"recording {seconds:.1f} s ... (Ctrl+C to stop early)")
    try:
        while time.time() - t0 < seconds:
            blocks += parser.feed(ser.read(8192))
    except KeyboardInterrupt:
        pass
    ser.write(b"S")
    time.sleep(0.2)
    blocks += parser.feed(ser.read(65536))
    ser.close()

    samples, missing = assemble(blocks)
    if len(samples) == 0:
        sys.exit("no audio received")

    out_dir = Path(args.out)
    out_dir.mkdir(parents=True, exist_ok=True)
    tag = "cleaned" if args.cleaned else (label if isinstance(label, str) else "+".join(label) or "none")
    stem = out_dir / f"{tag}_{datetime.now():%Y%m%d_%H%M%S}"
    # 24-bit PCM, left = primary, right = reference.
    sf.write(stem.with_suffix(".wav"), samples.astype(np.float64) / FULL_SCALE_24,
             SAMPLE_RATE, subtype="PCM_24")

    rms_db = 20 * np.log10(np.sqrt(np.mean((samples / FULL_SCALE_24) ** 2, axis=0)) + 1e-12)
    right = "cleaned" if args.cleaned else "reference"
    meta = {
        "labels": label,
        "channels": ["primary", "cleaned"] if args.cleaned else ["primary", "reference"],
        "cleaned_delay_samples": out_delay if args.cleaned else None,
        "played": str(args.play) if args.play else None,
        "seconds": len(samples) / SAMPLE_RATE,
        "missing_blocks": int(missing),
        "device_reported_dropped": int(blocks[-1].dropped),
        "bytes_skipped": parser.bytes_skipped,
        "level_dbfs": {"primary": round(float(rms_db[0]), 1), right: round(float(rms_db[1]), 1)},
        "device_info": info,
        "notes": args.notes,
    }
    stem.with_suffix(".json").write_text(json.dumps(meta, indent=2))
    print(f"saved {stem}.wav  ({meta['seconds']:.1f} s, {missing} blocks lost, "
          f"primary {rms_db[0]:.1f} dBFS, {right} {rms_db[1]:.1f} dBFS)")
    if missing:
        print("warning: blocks were lost; USB could not keep up. Close other programs using the port.")


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    sub = ap.add_subparsers(dest="cmd", required=True)

    lv = sub.add_parser("levels", help="live mic levels, for checking wiring")
    lv.add_argument("--port", required=True)
    lv.set_defaults(func=cmd_levels)

    rec = sub.add_parser("record", help="record both mics to a WAV file")
    rec.add_argument("--port", required=True)
    rec.add_argument("--label", nargs="+", choices=LABELS,
                     help="what is audible: any combination, e.g. --label impulsive speech")
    rec.add_argument("--seconds", type=float, default=120.0)
    rec.add_argument("--play", type=Path, help="play this WAV through the laptop while recording")
    rec.add_argument("--out", default="data/raw")
    rec.add_argument("--notes", default="", help="free text: where, what, mic distance")
    rec.add_argument("--cleaned", action="store_true",
                     help="record primary mic + canceller output instead of both mics (firmware 0.2+)")
    rec.set_defaults(func=cmd_record)

    args = ap.parse_args()
    args.func(args)


if __name__ == "__main__":
    main()
