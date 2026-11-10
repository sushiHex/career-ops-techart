"""housekeeping.py: the fortnightly tidy, dry run by default.

Four steps, in this order, each printed before it happens:

1. DELETE regenerable caches: tmp/go-build-cache, tmp/go-cache, scripts/.tmp and every
   __pycache__ outside node_modules and site-src.
2. ARCHIVE dated scratch into .archive/<today>/, preserving relative paths: every file and
   directory at the top of batch/ that is not pipeline memory, everything left in tmp/, and
   .playbook/ notes (those go to research/ instead, since they are decisions).
3. PURGE .archive/<date> directories older than --keep-days (default 60). The archive is a
   buffer, not a second attic.
4. REPORT what is uncommitted and how old it is. Nothing here commits; the report exists so
   the oldest uncommitted work is the first line you read.

Never touched: batch/eval-queue, batch/rescore-backup, batch/tracker-additions,
batch/linkedin-sweep, batch/logs, reports/, data/, output/, interview-prep/, research/,
site-src/. Those are the pipeline's own memory or another session's work.

Usage:
    python scripts/housekeeping.py            # dry run, prints the plan
    python scripts/housekeeping.py --apply    # does it
    python scripts/housekeeping.py --keep-days 90
"""
from __future__ import annotations

import argparse
import datetime as dt
import os
import shutil
import subprocess
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
TODAY = dt.date.today().isoformat()

CACHE_DIRS = ["tmp/go-build-cache", "tmp/go-cache", "scripts/.tmp"]
PYCACHE_SKIP = {"node_modules", "site-src", ".git"}

BATCH_KEEP = {
    "README.md", "batch-runner.sh", "batch-prompt.md",
    "logs", "eval-queue", "rescore-backup", "tracker-additions", "linkedin-sweep",
}
NEVER_TOUCH = {"reports", "data", "output", "interview-prep", "research", "site-src", "node_modules", ".git"}


def rel(p: Path) -> str:
    return p.relative_to(ROOT).as_posix()


def size_mb(p: Path) -> float:
    if p.is_file():
        return p.stat().st_size / 1e6
    return sum(f.stat().st_size for f in p.rglob("*") if f.is_file()) / 1e6


def plan_caches() -> list[Path]:
    out = [ROOT / d for d in CACHE_DIRS if (ROOT / d).exists()]
    for dirpath, dirnames, _ in os.walk(ROOT):
        dirnames[:] = [d for d in dirnames if d not in PYCACHE_SKIP]
        if Path(dirpath).name == "__pycache__":
            out.append(Path(dirpath))
            dirnames[:] = []
    return out


def plan_archive() -> list[tuple[Path, Path]]:
    moves: list[tuple[Path, Path]] = []
    archive = ROOT / ".archive" / TODAY
    batch = ROOT / "batch"
    if batch.exists():
        for p in sorted(batch.iterdir()):
            if p.name not in BATCH_KEEP:
                moves.append((p, archive / rel(p)))
    tmp = ROOT / "tmp"
    if tmp.exists():
        cache_set = {ROOT / d for d in CACHE_DIRS}
        for p in sorted(tmp.iterdir()):
            if p not in cache_set:
                moves.append((p, archive / rel(p)))
    playbook = ROOT / ".playbook"
    if playbook.exists():
        for p in sorted(playbook.iterdir()):
            if p.is_file():
                moves.append((p, ROOT / "research" / f"playbook-{p.name}"))
    return moves


def plan_purge(keep_days: int) -> list[Path]:
    archive = ROOT / ".archive"
    if not archive.exists():
        return []
    cutoff = dt.date.today() - dt.timedelta(days=keep_days)
    out = []
    for p in sorted(archive.iterdir()):
        if not p.is_dir():
            continue
        try:
            stamped = dt.date.fromisoformat(p.name[:10])
        except ValueError:
            continue
        if stamped < cutoff:
            out.append(p)
    return out


def report_uncommitted() -> None:
    try:
        raw = subprocess.run(
            ["git", "status", "--porcelain", "--untracked-files=all"],
            cwd=ROOT, capture_output=True, text=True, check=True,
        ).stdout
    except (subprocess.CalledProcessError, FileNotFoundError) as e:
        print(f"  git status failed: {e}")
        return
    rows = []
    for line in raw.splitlines():
        code, path = line[:2], line[3:].strip().strip('"')
        p = ROOT / path
        if any(part in NEVER_TOUCH for part in Path(path).parts):
            continue
        if p.exists():
            age = (dt.datetime.now() - dt.datetime.fromtimestamp(p.stat().st_mtime)).days
        else:
            age = -1
        rows.append((age, code, path))
    rows.sort(reverse=True)
    if not rows:
        print("  nothing uncommitted outside the ignored data trees")
        return
    print(f"  {len(rows)} uncommitted path(s), oldest first (days, status, path):")
    for age, code, path in rows[:25]:
        print(f"  {age:4d}  {code}  {path}")
    if len(rows) > 25:
        print(f"  ... and {len(rows) - 25} more")


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--apply", action="store_true", help="perform the plan (default is a dry run)")
    ap.add_argument("--keep-days", type=int, default=60, help="purge .archive entries older than this")
    args = ap.parse_args()
    mode = "APPLY" if args.apply else "DRY RUN"
    print(f"housekeeping {TODAY} [{mode}] in {ROOT}")

    caches = plan_caches()
    print(f"\n1. DELETE caches ({len(caches)}, {sum(size_mb(p) for p in caches):.1f} MB)")
    for p in caches:
        print(f"  - {rel(p)}")
        if args.apply:
            shutil.rmtree(p, ignore_errors=True)

    moves = plan_archive()
    print(f"\n2. ARCHIVE scratch ({len(moves)}, {sum(size_mb(s) for s, _ in moves):.1f} MB)")
    for src, dst in moves:
        print(f"  - {rel(src)}  ->  {rel(dst)}")
        if args.apply:
            if dst.exists():
                print(f"    SKIP: destination exists")
                continue
            dst.parent.mkdir(parents=True, exist_ok=True)
            shutil.move(str(src), str(dst))
    if args.apply:
        pb = ROOT / ".playbook"
        if pb.exists() and not any(pb.iterdir()):
            pb.rmdir()

    purge = plan_purge(args.keep_days)
    print(f"\n3. PURGE archive older than {args.keep_days} days ({len(purge)})")
    for p in purge:
        print(f"  - {rel(p)}  ({size_mb(p):.1f} MB)")
        if args.apply:
            shutil.rmtree(p, ignore_errors=True)

    print("\n4. UNCOMMITTED (report only)")
    report_uncommitted()

    if not args.apply:
        print("\ndry run; add --apply to perform steps 1 to 3")
    return 0


if __name__ == "__main__":
    sys.exit(main())
