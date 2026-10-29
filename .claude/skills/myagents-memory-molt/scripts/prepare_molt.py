#!/usr/bin/env python3
"""Prepare a MyAgents memory molt run."""

from __future__ import annotations

import argparse
import re
import sys
from datetime import date
from pathlib import Path



def find_repo_from_cwd() -> Path:
    current = Path.cwd().resolve()
    for candidate in (current, *current.parents):
        if (candidate / ".claude" / "rules").is_dir():
            return candidate
    print("ERROR: cannot find workspace with .claude/rules; pass --repo", file=sys.stderr)
    sys.exit(1)


def rule_files(repo: Path) -> list[Path]:
    """Inventory direct regular Markdown files; do not impose a template layout."""
    rules = repo / ".claude" / "rules"
    if not rules.is_dir():
        return []
    return sorted(
        (path for path in rules.iterdir()
         if not path.is_symlink() and path.is_file() and path.suffix.lower() == ".md"),
        key=lambda path: path.name,
    )


def find_rules(repo: Path, kind: str) -> list[Path]:
    # Filename hints only. The Skill interprets roles in the workspace's architecture.
    return [path for path in rule_files(repo) if kind in path.name.lower()]


def rel(repo: Path, path: Path) -> str:
    try:
        return path.relative_to(repo).as_posix()
    except ValueError:
        return path.as_posix()


def parse_iso_date(text: str) -> date | None:
    match = re.search(r"(\d{4})-(\d{2})-(\d{2})", text)
    if not match:
        return None
    try:
        return date(int(match.group(1)), int(match.group(2)), int(match.group(3)))
    except ValueError:
        return None


def days_between(a: date, b: date) -> int:
    return abs((b - a).days)


def collect_recent_logs(memory_dir: Path, today: date, days: int = 30) -> list[Path]:
    rows: list[tuple[date, Path]] = []
    if not memory_dir.is_dir():
        return []
    for path in memory_dir.glob("*.md"):
        parsed = parse_iso_date(path.name)
        if parsed and days_between(parsed, today) <= days:
            rows.append((parsed, path))
    rows.sort(key=lambda item: item[0], reverse=True)
    return [path for _, path in rows]


def topic_last_updated(path: Path) -> tuple[date | None, str]:
    try:
        head = path.read_text(encoding="utf-8", errors="ignore")[:2000]
    except OSError:
        return None, "?"
    match = re.search(r"[Ll]ast\s*[Uu]pdated[:\s]*\*?\s*(\d{4}-\d{2}-\d{2})", head)
    if match:
        return parse_iso_date(match.group(1)), "header"
    return date.fromtimestamp(path.stat().st_mtime), "mtime"


def collect_topics(topics_dir: Path, today: date) -> list[tuple[str, date | None, int | None, str]]:
    if not topics_dir.is_dir():
        return []
    rows = []
    for path in sorted(topics_dir.glob("*.md")):
        last, source = topic_last_updated(path)
        rows.append((path.name, last, days_between(last, today) if last else None, source))
    rows.sort(key=lambda item: (item[2] is None, -(item[2] or 0)))
    return rows


def find_last_molt(molts_dir: Path) -> tuple[Path | None, date | None, int]:
    if not molts_dir.is_dir():
        return None, None, 0
    rows: list[tuple[date, int, Path]] = []
    for path in molts_dir.glob("*molt*.md"):
        parsed = parse_iso_date(path.name)
        number_match = re.search(r"molt-(\d+)", path.name)
        if parsed:
            rows.append((parsed, int(number_match.group(1)) if number_match else 0, path))
    if not rows:
        return None, None, 0
    rows.sort(reverse=True)
    max_number = max(row[1] for row in rows)
    return rows[0][2], rows[0][0], max_number


def bold_lead(text: str, maxlen: int = 90) -> str:
    lead = re.sub(r"\s+", " ", text).strip()
    return lead if len(lead) <= maxlen else lead[: maxlen - 1] + "..."


def list_items(path: Path | None, limit: int = 60) -> list[str]:
    if path is None or not path.is_file():
        return []
    try:
        text = path.read_text(encoding="utf-8", errors="ignore")
    except OSError:
        return []
    items: list[str] = []
    for line in text.splitlines():
        stripped = line.strip()
        if stripped.startswith("- "):
            items.append(bold_lead(stripped[2:]))
        elif stripped.startswith("**") and stripped.endswith("**"):
            items.append(bold_lead(stripped.strip("*")))
        if len(items) >= limit:
            break
    return items


def last_molt_promises(last_file: Path | None) -> list[str]:
    if last_file is None:
        return []
    try:
        text = last_file.read_text(encoding="utf-8", errors="ignore")
    except OSError:
        return []
    match = re.search(r"#{2,4}\s*(?:给下次 molt 的承诺|Next Molt Promises)\s*\n(.*?)(?=\n#|\Z)", text, re.S)
    if not match:
        return []
    return [
        bold_lead(re.sub(r"^\s*(?:-|\d+\.)\s*", "", line), 90)
        for line in match.group(1).splitlines()
        if re.match(r"^\s*(?:-|\d+\.)\s", line)
    ]


def gardener_flags(repo: Path) -> list[str]:
    path = repo / "memory" / "gardener" / "flags-for-molt.md"
    if not path.is_file():
        return []
    return [
        bold_lead(line.strip()[2:], 90)
        for line in path.read_text(encoding="utf-8", errors="ignore").splitlines()
        if line.strip().startswith("- ")
    ]


def checkboxes(items: list[str], empty_note: str) -> str:
    if not items:
        return f"- [x] {empty_note}\n"
    return "".join(f"- [ ] {item}\n" for item in items)


def init_progress(repo: Path, today: date) -> None:
    memory_dir = repo / "memory"
    molts_dir = memory_dir / "molts"
    molts_dir.mkdir(parents=True, exist_ok=True)

    last_file, _, max_number = find_last_molt(molts_dir)
    number = max_number + 1
    progress_path = molts_dir / f"{today.isoformat()}-molt-{number:03d}.progress.md"
    if progress_path.exists():
        print(f"exists, not overwriting: {rel(repo, progress_path)}")
        return

    soul_items = [f"{rel(repo, path)}: {item}"
                  for path in find_rules(repo, "soul")
                  for item in list_items(path, limit=60)]
    user_items = [f"{rel(repo, path)}: {item}"
                  for path in find_rules(repo, "user")
                  for item in list_items(path, limit=30)]
    memory_items = [f"{rel(repo, path)}: {item}"
                  for path in find_rules(repo, "memory")
                  for item in list_items(path, limit=60)]
    promises = last_molt_promises(last_file)
    flags = gardener_flags(repo)
    logs = collect_recent_logs(memory_dir, today)
    topics = collect_topics(memory_dir / "topics", today)
    stalled = [f"{name} ({days} days)" for name, _, days, _ in topics if days is not None and days >= 30]

    content = f"""# Molt {number:03d} Progress - {today.isoformat()}

Rules:
- Change each completed item to `[x]` and add a short result.
- Change intentionally skipped items to `[defer]` with a reason.
- Unmarked `[ ]` items mean the molt is not complete.

## 0. Opening
- [ ] Molt document created with the seven hard rules and scope.

## 1. Pattern Mining
- [ ] Read recent logs ({len(logs)} files).
- [ ] Read active and stale topics ({len(topics)} files).
- [ ] Produce at least 3 cross-time patterns.

## 2. Belief Audit - MEMORY ({len(memory_items)} parsed items)
{checkboxes(memory_items, "No parsed MEMORY items; inspect the existing architecture and audit this role if applicable.")}
## 3. User Model Audit - USER ({len(user_items)} parsed items)
{checkboxes(user_items, "No parsed USER items; inspect the existing architecture and audit this role if applicable.")}
## 4. External Verification
- [ ] Verify at least 3 time-sensitive claims, or mark them unverified.

## 5. Identity Coherence - SOUL ({len(soul_items)} parsed items)
{checkboxes(soul_items, "No parsed SOUL items; inspect the existing architecture and audit this role if applicable.")}
## 6. Five Required Outputs
- [ ] New accepted belief.
- [ ] Rejected old belief.
- [ ] Pattern upgraded into SOUL / USER / MEMORY.
- [ ] Direction, project, or habit to stop / downgrade / hibernate.
- [ ] Capability gap and follow-up mechanism.

## 7. Gardener Flags ({len(flags)} items)
{checkboxes(flags, "No gardener flags.")}
## 8. Stalled Topics ({len(stalled)} items)
{checkboxes(stalled, "No stalled topics.")}
## 9. Previous Molt Promises ({len(promises)} items)
{checkboxes(promises, "No previous promises.")}
## 10. Landing
- [ ] Metadata files modified as needed.
- [ ] Gardener lint run when available.
- [ ] Processed gardener flags cleared or marked.
- [ ] Molt document includes landing table and next promises.
- [ ] Git commit created if this workspace is a git repository; no push.
"""
    progress_path.write_text(content, encoding="utf-8")
    print(f"created: {rel(repo, progress_path)}")


def print_preparation(repo: Path, today: date) -> None:
    memory_dir = repo / "memory"
    last_file, last_date, max_number = find_last_molt(memory_dir / "molts")
    next_number = max_number + 1

    print(f"# Molt Preparation - {today.isoformat()}\n")
    print("## Rule Files\n")
    files = rule_files(repo)
    for path in files:
        print(f"- `{rel(repo, path)}`")
    if not files:
        print("- No direct Markdown rules found; inspect the workspace's memory architecture.")
    print("\nNames are hints, not required layers. Read the workspace rules to determine scope.")
    print()

    print("## Previous Molt\n")
    if last_file and last_date:
        print(f"- file: `{rel(repo, last_file)}`")
        print(f"- age: {days_between(last_date, today)} days")
    else:
        print("- none")
    print(f"- next file: `memory/molts/{today.isoformat()}-molt-{next_number:03d}.md`\n")

    print("## Recent Logs\n")
    logs = collect_recent_logs(memory_dir, today)
    for path in logs:
        print(f"- `{rel(repo, path)}`")
    if not logs:
        print("- none")
    print()

    print("## Topics\n")
    topics = collect_topics(memory_dir / "topics", today)
    if topics:
        print("| Topic | Last Updated | Days Since | Source |")
        print("|---|---|---:|---|")
        for name, last, days, source in topics:
            marker = " stalled" if days is not None and days >= 30 else ""
            print(f"| {name} | {last.isoformat() if last else '?'} | {days if days is not None else '?'}{marker} | {source} |")
    else:
        print("- none")
    print()

    flags = gardener_flags(repo)
    print(f"## Gardener Flags ({len(flags)})\n")
    for item in flags:
        print(f"- {item}")
    if not flags:
        print("- none")
    print()

    promises = last_molt_promises(last_file)
    print(f"## Previous Promises ({len(promises)})\n")
    for item in promises:
        print(f"- {item}")
    if not promises:
        print("- none")
    print()

    print(f"Next: python3 {Path(__file__).name} --repo {repo} --init-progress")


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--repo", default=None)
    parser.add_argument("--init-progress", action="store_true")
    args = parser.parse_args()

    repo = Path(args.repo).expanduser().resolve() if args.repo else find_repo_from_cwd()
    today = date.today()
    if args.init_progress:
        init_progress(repo, today)
    else:
        print_preparation(repo, today)
    return 0


if __name__ == "__main__":
    sys.exit(main())
