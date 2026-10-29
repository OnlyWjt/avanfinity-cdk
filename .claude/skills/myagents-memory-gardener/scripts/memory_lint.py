#!/usr/bin/env python3
"""Generic memory lint for MyAgents long-term memory workspaces."""

from __future__ import annotations

import argparse
import json
import re
import subprocess
import sys
from datetime import date, datetime, timedelta
from pathlib import Path


BUDGETS = {
    "memory": 50 * 1024,
    "user": 20 * 1024,
    "soul": 6 * 1024,
}
BUDGET_WARN_RATIO = 0.85
LOG_GAP_WINDOW_DAYS = 14
GARDENER_OVERDUE_HOURS = 96
MOLT_OVERDUE_DAYS = 21
VERIFIED_STALE_DAYS = 45
STATE_FILE = "memory/gardener/state.json"


class Report:
    def __init__(self) -> None:
        self.items: list[dict[str, str]] = []

    def add(self, level: str, check: str, message: str) -> None:
        self.items.append({"level": level, "check": check, "message": message})

    def red(self, check: str, message: str) -> None:
        self.add("RED", check, message)

    def warn(self, check: str, message: str) -> None:
        self.add("WARN", check, message)

    def info(self, check: str, message: str) -> None:
        self.add("INFO", check, message)


def sh(repo: Path, *args: str) -> str:
    result = subprocess.run(args, cwd=repo, capture_output=True, text=True, check=False)
    return result.stdout.strip()


def is_git_repo(repo: Path) -> bool:
    result = subprocess.run(
        ["git", "rev-parse", "--is-inside-work-tree"],
        cwd=repo,
        capture_output=True,
        text=True,
        check=False,
    )
    return result.returncode == 0 and result.stdout.strip() == "true"


def find_repo_from_cwd() -> Path:
    current = Path.cwd().resolve()
    for candidate in (current, *current.parents):
        if (candidate / ".claude" / "rules").is_dir():
            return candidate
    return current


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


def check_rule_substrate(repo: Path, report: Report) -> dict[str, list[Path]]:
    files = rule_files(repo)
    for path in files:
        report.info("substrate", rel(repo, path))
    if not files:
        report.info("substrate", "未发现直接 Markdown 规则文件；先理解工作区记忆结构")
    found = {kind: find_rules(repo, kind) for kind in ("soul", "user", "memory")}
    for kind, paths in found.items():
        if not paths:
            report.info("substrate", f"未按文件名识别到 {kind} 层；不代表缺少必要文件")
    return found


def check_budgets(repo: Path, report: Report, rules: dict[str, list[Path]]) -> None:
    for kind, budget in BUDGETS.items():
        for path in rules.get(kind, []):
            size = path.stat().st_size
            pct = size / budget
            desc = f"{rel(repo, path)}: {size / 1024:.1f}KB / {budget / 1024:.0f}KB ({pct:.0%})"
            if pct > 1.0:
                report.red("budget", f"超预算 - {desc}")
            elif pct > BUDGET_WARN_RATIO:
                report.warn("budget", f"接近预算 - {desc}")
            else:
                report.info("budget", f"OK - {desc}")


def check_log_gaps(repo: Path, report: Report, today: date) -> None:
    memory_dir = repo / "memory"
    if not memory_dir.is_dir():
        report.info("log-gap", "未发现 memory/；跳过默认布局的日志检查")
        return
    if not is_git_repo(repo):
        report.info("log-gap", "非 git 仓库，跳过 git 活动日志洞检查")
        return

    commit_dates = set(
        sh(
            repo,
            "git",
            "log",
            f"--since={LOG_GAP_WINDOW_DAYS}.days",
            "--format=%ad",
            "--date=short",
        ).splitlines()
    )
    missing_active: list[str] = []
    for i in range(1, LOG_GAP_WINDOW_DAYS + 1):
        day = today - timedelta(days=i)
        iso = day.isoformat()
        if iso in commit_dates and not (memory_dir / f"{iso}.md").exists():
            missing_active.append(iso)
    if missing_active:
        report.warn("log-gap", f"默认日志路径未发现记录；按工作区约定确认是否需要补记: {', '.join(sorted(missing_active))}")
    else:
        report.info("log-gap", f"近 {LOG_GAP_WINDOW_DAYS} 天无 git 活动日志洞")


def check_gardener_deadman(repo: Path, report: Report) -> None:
    path = repo / STATE_FILE
    if not path.exists():
        report.info("dead-man", "无园丁运行记录，可能是首次运行")
        return
    try:
        state = json.loads(path.read_text(encoding="utf-8"))
        last = datetime.fromisoformat(state["last_run"])
    except (OSError, KeyError, ValueError, json.JSONDecodeError) as exc:
        report.warn("dead-man", f"无法解析 {STATE_FILE}: {exc}")
        return
    hours = (datetime.now() - last).total_seconds() / 3600
    if hours > GARDENER_OVERDUE_HOURS:
        report.red("dead-man", f"园丁上次运行在 {hours:.0f} 小时前，检查 Evo 定时任务")
    else:
        report.info("dead-man", f"园丁上次运行 {hours:.0f} 小时前")


def check_molt_overdue(repo: Path, report: Report, today: date) -> None:
    molts_dir = repo / "memory" / "molts"
    if not molts_dir.is_dir():
        report.info("molt", "无 memory/molts/，首次 molt 前可接受")
        return
    candidates: list[tuple[date, Path]] = []
    for path in molts_dir.glob("*molt*.md"):
        parsed = parse_iso_date(path.name)
        if parsed:
            candidates.append((parsed, path))
    if not candidates:
        report.info("molt", "无 molt 记录")
        return
    last, path = sorted(candidates)[-1]
    days = (today - last).days
    if days > MOLT_OVERDUE_DAYS:
        report.warn("molt", f"molt 距今 {days} 天，上次 {rel(repo, path)}")
    else:
        report.info("molt", f"上次 molt {days} 天前: {rel(repo, path)}")


def check_stale_verified(repo: Path, report: Report, memory_path: Path | None, today: date) -> None:
    if memory_path is None:
        return
    try:
        text = memory_path.read_text(encoding="utf-8")
    except OSError as exc:
        report.warn("stale-verified", f"无法读取 {rel(repo, memory_path)}: {exc}")
        return
    stale: list[str] = []
    for match in re.finditer(r"verified[: ]+(\d{4}-\d{2}-\d{2})", text, flags=re.I):
        verified = date.fromisoformat(match.group(1))
        age = (today - verified).days
        if age > VERIFIED_STALE_DAYS:
            stale.append(f"{verified.isoformat()}({age}d)")
    if stale:
        report.warn("stale-verified", f"过期 verified 标记: {', '.join(stale)}")
    else:
        report.info("stale-verified", "无过期 verified 标记")


def check_topic_pointers(repo: Path, report: Report, memory_path: Path | None) -> None:
    if memory_path is None:
        return
    try:
        text = memory_path.read_text(encoding="utf-8")
    except OSError as exc:
        report.warn("pointer", f"无法读取 {rel(repo, memory_path)}: {exc}")
        return
    missing = sorted(
        {
            match.group(1)
            for match in re.finditer(r"memory/topics/([A-Za-z0-9_.-]+\.md)", text)
            if not (repo / "memory" / "topics" / match.group(1)).exists()
        }
    )
    if missing:
        report.red("pointer", f"指向不存在的 topic: {', '.join(missing)}")
    else:
        report.info("pointer", "memory/topics 指针全部有效")


def mark_run(repo: Path) -> None:
    path = repo / STATE_FILE
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(
        json.dumps({"last_run": datetime.now().isoformat(timespec="seconds")}, indent=2)
        + "\n",
        encoding="utf-8",
    )
    print(f"recorded run -> {STATE_FILE}")


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--repo", default=None, help="Workspace root. Defaults to nearest cwd parent with .claude/rules.")
    parser.add_argument("--json", action="store_true")
    parser.add_argument("--mark-run", action="store_true")
    args = parser.parse_args()

    repo = Path(args.repo).expanduser().resolve() if args.repo else find_repo_from_cwd()
    if args.mark_run:
        mark_run(repo)
        return 0

    today = date.today()
    report = Report()
    rules = check_rule_substrate(repo, report)
    check_budgets(repo, report, rules)
    check_log_gaps(repo, report, today)
    check_gardener_deadman(repo, report)
    check_molt_overdue(repo, report, today)
    for memory_path in rules["memory"]:
        check_stale_verified(repo, report, memory_path, today)
        check_topic_pointers(repo, report, memory_path)

    if args.json:
        print(json.dumps(report.items, ensure_ascii=False, indent=2))
        return 0

    for level in ("RED", "WARN", "INFO"):
        for item in report.items:
            if item["level"] == level:
                print(f"[{level}] [{item['check']}] {item['message']}")
    reds = sum(1 for item in report.items if item["level"] == "RED")
    warns = sum(1 for item in report.items if item["level"] == "WARN")
    print(f"\n== {reds} RED / {warns} WARN ==")
    return 0


if __name__ == "__main__":
    sys.exit(main())
