#!/usr/bin/env python3
"""Download a subset of the Microsoft DNS Challenge (Interspeech 2020) data.

Clean read speech (many speakers, 16 kHz) and a wide range of noise clips,
used to train the neural noise suppressor. The files live in Git LFS on
GitHub, so only the ones picked are downloaded.

    python tools/fetch_dns_subset.py --clean 400 --noise 600 --out data/dns

Licence: see the DNS-Challenge repository (clean speech from Librivox,
noise from Audioset / Freesound / DEMAND).
"""
from __future__ import annotations

import argparse
import random
import subprocess
import sys
import tempfile
import urllib.request
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

REPO = "https://github.com/microsoft/DNS-Challenge"
BRANCH = "interspeech2020/master"
MEDIA = f"https://media.githubusercontent.com/media/microsoft/DNS-Challenge/{BRANCH}/"


def list_files() -> list[str]:
    with tempfile.TemporaryDirectory() as d:
        subprocess.run(["git", "clone", "-q", "--filter=blob:none", "--no-checkout", "--depth", "1",
                        "-b", BRANCH, REPO, d], check=True, env={"GIT_LFS_SKIP_SMUDGE": "1", "PATH": "/usr/bin:/bin"})
        out = subprocess.run(["git", "-C", d, "ls-tree", "-r", "--name-only", "HEAD"],
                             check=True, capture_output=True, text=True).stdout
    return out.split()


def fetch(path: str, out_dir: Path) -> bool:
    dest = out_dir / Path(path).name
    if dest.exists() and dest.stat().st_size > 1000:
        return True
    try:
        urllib.request.urlretrieve(MEDIA + path, dest)
        return dest.stat().st_size > 1000
    except Exception as e:  # network hiccups: skip the file, keep going
        print(f"  failed {path}: {e}", file=sys.stderr)
        return False


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--clean", type=int, default=400)
    ap.add_argument("--noise", type=int, default=600)
    ap.add_argument("--out", type=Path, default=Path("data/dns"))
    ap.add_argument("--seed", type=int, default=0)
    ap.add_argument("--workers", type=int, default=8)
    a = ap.parse_args()

    files = list_files()
    clean = [f for f in files if f.startswith("datasets/clean/") and f.endswith(".wav")]
    noise = [f for f in files if f.startswith("datasets/noise/") and f.endswith(".wav")]
    rng = random.Random(a.seed)
    picks = [("clean", p) for p in rng.sample(clean, a.clean)] + [("noise", p) for p in rng.sample(noise, a.noise)]
    print(f"repository has {len(clean)} clean and {len(noise)} noise files; fetching {a.clean} + {a.noise}")
    for sub in ("clean", "noise"):
        (a.out / sub).mkdir(parents=True, exist_ok=True)
    with ThreadPoolExecutor(a.workers) as ex:
        ok = list(ex.map(lambda t: fetch(t[1], a.out / t[0]), picks))
    print(f"done: {sum(ok)}/{len(ok)} files in {a.out}")


if __name__ == "__main__":
    main()
