"""Host side of the recording protocol. Mirrors firmware main/host_link.h.

Frame layout (little-endian):
    b"ANCF" | seq:u32 | nframes:u16 | dropped:u16 | nframes x (primary, reference) x s24

The parser resyncs on the magic, so it tolerates starting mid-frame and stray
text lines (the device may still be draining frames right after 'S').
"""
from __future__ import annotations

import struct
from dataclasses import dataclass

import numpy as np

MAGIC = b"ANCF"
HEADER = struct.Struct("<4sIHH")
SAMPLE_BYTES = 3
CHANNELS = 2
# One block per 10 ms. The parser rejects any other size, which is also what
# stops a magic-looking byte run inside audio data from being taken as a header.
BLOCK_FRAMES = 160
FULL_SCALE_24 = float(1 << 23)


@dataclass
class Block:
    seq: int
    dropped: int
    samples: np.ndarray  # (BLOCK_FRAMES, 2) int32: column 0 primary, 1 reference


def decode_s24(payload: bytes) -> np.ndarray:
    """Little-endian packed signed 24-bit -> int32."""
    raw = np.frombuffer(payload, dtype=np.uint8).reshape(-1, 3).astype(np.int32)
    v = raw[:, 0] | (raw[:, 1] << 8) | (raw[:, 2] << 16)
    return np.where(v & 0x800000, v - (1 << 24), v).astype(np.int32)


def encode_block(seq: int, dropped: int, samples: np.ndarray) -> bytes:
    """Build a frame exactly as the firmware does. Used by tests and simulators."""
    s = np.asarray(samples, dtype=np.int32).reshape(-1)
    u = (s & 0xFFFFFF).astype(np.uint32)
    packed = np.stack([u & 0xFF, (u >> 8) & 0xFF, (u >> 16) & 0xFF], axis=1).astype(np.uint8)
    return HEADER.pack(MAGIC, seq, len(samples), min(dropped, 0xFFFF)) + packed.tobytes()


class FrameParser:
    """Incremental parser: feed() arbitrary byte chunks, get complete Blocks back."""

    def __init__(self) -> None:
        self._buf = bytearray()
        self.bytes_skipped = 0

    def feed(self, data: bytes) -> list[Block]:
        self._buf.extend(data)
        out: list[Block] = []
        payload_len = BLOCK_FRAMES * CHANNELS * SAMPLE_BYTES
        frame_len = HEADER.size + payload_len
        while True:
            i = self._buf.find(MAGIC)
            if i < 0:
                # Keep the last 3 bytes: they may be the start of a split magic.
                keep = min(len(self._buf), len(MAGIC) - 1)
                self.bytes_skipped += len(self._buf) - keep
                del self._buf[: len(self._buf) - keep]
                return out
            if i > 0:
                self.bytes_skipped += i
                del self._buf[:i]
            if len(self._buf) < HEADER.size:
                return out
            _, seq, nframes, dropped = HEADER.unpack_from(self._buf, 0)
            if nframes != BLOCK_FRAMES:
                # Not a real header: skip past this magic and search again.
                self.bytes_skipped += 1
                del self._buf[:1]
                continue
            if len(self._buf) < frame_len:
                return out
            samples = decode_s24(bytes(self._buf[HEADER.size:frame_len])).reshape(-1, CHANNELS)
            out.append(Block(seq=seq, dropped=dropped, samples=samples))
            del self._buf[:frame_len]


def assemble(blocks: list[Block]) -> tuple[np.ndarray, int]:
    """Concatenate blocks in seq order, filling lost blocks with zeros.

    Returns (samples (N, 2) int32, number of missing blocks). Zero-filling keeps
    primary and reference aligned in time, which matters more for this project
    than a gap-free file: the canceller learns their time relationship.
    """
    if not blocks:
        return np.zeros((0, CHANNELS), dtype=np.int32), 0
    first, last = blocks[0].seq, blocks[-1].seq
    n_blocks = last - first + 1
    out = np.zeros((n_blocks * BLOCK_FRAMES, CHANNELS), dtype=np.int32)
    seen = set()
    for b in blocks:
        k = b.seq - first
        if 0 <= k < n_blocks and k not in seen:
            out[k * BLOCK_FRAMES:(k + 1) * BLOCK_FRAMES] = b.samples
            seen.add(k)
    return out, n_blocks - len(seen)
