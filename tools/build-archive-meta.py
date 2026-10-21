#!/usr/bin/env python3
"""Join the bot-era archive (data/art.json) to the tweets and scripts that made it.

    python3 tools/build-archive-meta.py <archive-tweets.tsv> <path to a twitter-artbot clone>

Inputs
  archive-tweets.tsv   one row per archived tweet: date (UTC, YYYY-MM-DDTHH:MM:SS) \t tweet text
                       \t tweet status id. A row belongs to the art.json entry whose date (first
                       19 chars) is the same.
  twitter-artbot       a clone of github.com/ejfox/twitter-artbot (all branches fetched).

Outputs (both committed)
  data/archive-meta.json        keyed by the art.json entry's url
  data/artscripts/<name>.coffee the source of every referenced script, as committed

data/art.json is only read, never written.

Tweet text = optional words + `<script>-<seed>`, maybe followed by ` #bot2bot @handle`.
A script's source comes from master HEAD when it is still there, else from the last commit that
contained it (the parent of the commit that deleted it), unless PIN names the commit. REDACT lists lines that must not be
republished; they are replaced by a `# [removed]` marker.
"""

import json
import re
import subprocess
import sys
from pathlib import Path

REPO_URL = "https://github.com/ejfox/twitter-artbot"
ROOT = Path(__file__).resolve().parent.parent
ART = ROOT / "data" / "art.json"
OUT = ROOT / "data" / "archive-meta.json"
VENDOR = ROOT / "data" / "artscripts"

# script -> (commit, repo path) to use instead of the master/last-commit rule, when the script
# was edited after the archived pieces were made and the later version is not the one that made
# them (or must not be linked).
PIN = {
    # 3-4-4 as committed 2018-03-04: the word list that made the March-May 2018 pieces
    # ('417', '417am', '@', '<3', 'love me'); its later edits replaced those words
    "3-4-4": ("3f2bcbf507f5e0385641bf79a72f05311ddfa815", "src/artscripts/3-4-4.coffee"),
}

# repo path -> 1-based inclusive line ranges to remove. Each removed line must be a commented-out
# word-list entry (asserted below), so a shifted file fails loudly instead of cutting code.
REDACT: dict[str, list[tuple[int, int]]] = {}
COMMENTED_WORD = re.compile(r"^\s*#\s*'[^']*'\s*$")

BOT2BOT = re.compile(r"\s*#bot2bot\s+(@\w+)\s*$")
SCRIPT_SEED = re.compile(r"^(?P<words>.*?)(?P<script>(?:\d{4}/)?[\d-]*\d)-(?P<seed>\d{10,})$")


def git(repo: Path, *args: str) -> str:
    return subprocess.run(["git", "-C", str(repo), *args], check=True, capture_output=True, text=True).stdout.strip()


def exists(repo: Path, rev: str, path: str) -> bool:
    return subprocess.run(["git", "-C", str(repo), "cat-file", "-e", f"{rev}:{path}"], capture_output=True).returncode == 0


def locate(repo: Path, script: str, head: str) -> tuple[str, str]:
    """-> (repo path, commit sha)"""
    if script in PIN:
        commit, path = PIN[script]
        if not exists(repo, commit, path):
            raise SystemExit(f"pinned {script!r} not at {commit[:7]}:{path}")
        return path, commit
    name = script.split("/")[-1]
    if "/" in script:
        candidates = [f"src/artscripts/{script}.coffee"]
    else:
        candidates = [f"src/artscripts/2017/{name}.coffee", f"src/artscripts/2018/{name}.coffee",
                      f"src/artscripts/{name}.coffee"]
    for p in candidates:
        if exists(repo, head, p):
            return p, head
    for p in candidates:
        # newest commit touching the path; if it deleted the file, step back to its parent
        last = git(repo, "rev-list", "-n1", "--all", "--", p)
        if not last:
            continue
        if exists(repo, last, p):
            return p, last
        parent = git(repo, "rev-parse", f"{last}^")
        if exists(repo, parent, p):
            return p, parent
    raise SystemExit(f"script {script!r} not found in any commit")


def redact(path: str, src: str) -> tuple[str, int]:
    ranges = REDACT.get(path)
    if not ranges:
        return src, 0
    lines = src.split("\n")
    n = 0
    for a, b in ranges:
        for i in range(a - 1, b):
            if not COMMENTED_WORD.match(lines[i]):
                raise SystemExit(f"{path}:{i + 1} is not a commented word-list line; update REDACT")
            indent = lines[i][: len(lines[i]) - len(lines[i].lstrip())]
            lines[i] = None  # type: ignore[call-overload]
            n += 1
        lines[a - 1] = f"{indent}# [removed]"
    return "\n".join(l for l in lines if l is not None), n


def main() -> None:
    if len(sys.argv) != 3:
        raise SystemExit(__doc__)
    tsv, repo = Path(sys.argv[1]), Path(sys.argv[2])
    head = git(repo, "rev-parse", "master")

    art = json.loads(ART.read_text())
    by_date: dict[str, list[dict]] = {}
    for e in art:
        by_date.setdefault(e["date"][:19], []).append(e)

    meta: dict[str, dict] = {}
    scripts: dict[str, tuple[str, str]] = {}
    for line in tsv.read_text().splitlines():
        if not line.strip():
            continue
        date, text, tweet_id = line.split("\t")
        hits = by_date.get(date, [])
        if len(hits) != 1:
            raise SystemExit(f"{date}: {len(hits)} archive entries match")
        body, bot2bot = text, None
        m = BOT2BOT.search(body)
        if m:
            bot2bot, body = m.group(1), body[: m.start()]
        m = SCRIPT_SEED.match(body)
        if not m:
            raise SystemExit(f"{date}: no <script>-<seed> in {text!r}")
        script = m.group("script")
        if script not in scripts:
            scripts[script] = locate(repo, script, head)
        path, commit = scripts[script]
        rec = {
            "script": script,
            "seed": m.group("seed"),
            "tweet_id": tweet_id,
            "tweet_text": body,
            "script_path": path,
            "commit": commit,
            # the date the vendored source was last changed (not the commit it is linked at)
            "script_date": git(repo, "log", "-1", "--format=%cs", commit, "--", path),
            "github_url": f"{REPO_URL}/blob/{commit}/{path}",
            "vendored": f"data/artscripts/{script.split('/')[-1]}.coffee",
        }
        if bot2bot:
            rec["bot2bot"] = bot2bot
        meta[hits[0]["url"]] = rec

    VENDOR.mkdir(parents=True, exist_ok=True)
    for script, (path, commit) in sorted(scripts.items()):
        src, n = redact(path, git(repo, "show", f"{commit}:{path}") + "\n")
        (VENDOR / f"{script.split('/')[-1]}.coffee").write_text(src)
        print(f"vendored {script:12} {commit[:7]} {path}{f'  ({n} lines removed)' if n else ''}")

    ordered = {e["url"]: meta[e["url"]] for e in art if e["url"] in meta}
    OUT.write_text(json.dumps(ordered, indent=2, ensure_ascii=False) + "\n")
    print(f"{len(ordered)} of {len(art)} archive entries matched, {len(scripts)} scripts")


if __name__ == "__main__":
    main()
