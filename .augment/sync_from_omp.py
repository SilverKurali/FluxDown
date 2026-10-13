#!/usr/bin/env python3
"""由 .omp/ 生成 .augment/{rules,agents,skills}（.omp 是唯一事实源，生成物勿手改）。

用法：
  python3 .augment/sync_from_omp.py          # 写入/更新生成物
  python3 .augment/sync_from_omp.py --check  # 只校验是否漂移，漂移则退出码 1
"""
import json
import re
import shutil
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
OMP, AUG = ROOT / ".omp", ROOT / ".augment"
MARK = "<!-- 由 .omp/ 生成（python3 .augment/sync_from_omp.py），请改 .omp 源文件 -->"
# 短小且为硬红线的规则每次都带上，其余按 description 由 agent 自行判断是否引入。
ALWAYS = {"forbidden-commands"}
FM = re.compile(r"\A---\r?\n(.*?)\r?\n---\r?\n?(.*)\Z", re.S)


def split(text):
    m = FM.match(text)
    return (m.group(1), m.group(2)) if m else ("", text)


def field(meta, key):
    m = re.search(rf"^{key}:\s*(?:>-\s*\n((?:[ \t]+.*\n?)+)|(.*))$", meta, re.M)
    if not m:
        return ""
    raw = m.group(1) or m.group(2) or ""
    return " ".join(s.strip() for s in raw.splitlines()).strip().strip("'\"")


def fix_refs(body):
    return re.sub(r"rule://([A-Za-z0-9_-]+)", r".omp/rules/\1.md", body)


def rule_file(kind, desc, body):
    head = f"type: {kind}\n"
    if kind == "agent_requested":
        head += f"description: {json.dumps(desc, ensure_ascii=False)}\n"
    return f"---\n{head}---\n{MARK}\n\n{fix_refs(body).strip()}\n"


def expected():
    out = {}
    sticky = OMP / "RULES.md"
    if sticky.is_file():
        out[AUG / "rules/omp-sticky-rules.md"] = rule_file("always_apply", "", sticky.read_text("utf-8"))
    for p in sorted((OMP / "rules").glob("*.md")):
        meta, body = split(p.read_text("utf-8"))
        kind = "always_apply" if p.stem in ALWAYS else "agent_requested"
        desc = field(meta, "description") or p.stem
        out[AUG / f"rules/omp-{p.stem}.md"] = rule_file(kind, desc, body)
    for p in sorted((OMP / "agents").glob("*.md")):
        meta, body = split(p.read_text("utf-8"))
        name, desc = field(meta, "name") or p.stem, field(meta, "description")
        head = f"name: {name}\ndescription: {json.dumps(desc, ensure_ascii=False)}\n"
        # omp 的 read/grep/glob/bash 对应 auggie 的 view/codebase-retrieval/launch-process。
        head += "tools: view, codebase-retrieval, launch-process\n"
        out[AUG / f"agents/{p.stem}.md"] = f"---\n{head}---\n{MARK}\n\n{body.strip()}\n"
    watch = OMP / "WATCHDOG.md"
    if watch.is_file():
        head = "name: advisor\ndescription: \"按严重级（Blocker/Concern/Nit）审查当前改动是否违反 FluxDown 的 crate 边界、FFI 契约与依赖政策；只读，不修改文件。\"\n"
        head += "tools: view, codebase-retrieval, launch-process\n"
        out[AUG / "agents/advisor.md"] = f"---\n{head}---\n{MARK}\n\n{watch.read_text('utf-8').strip()}\n"
    return out


def skill_files():
    out = {}
    for f in sorted((OMP / "skills").rglob("*")):
        if f.is_file() and "__pycache__" not in f.parts:
            out[AUG / "skills" / f.relative_to(OMP / "skills")] = f.read_bytes()
    return out


def generated_on_disk():
    found = set()
    for sub in ("rules", "agents"):
        for p in (AUG / sub).glob("*.md"):
            if MARK in p.read_text("utf-8"):
                found.add(p)
    return found


def main():
    check = "--check" in sys.argv
    want = {p: s.encode("utf-8") for p, s in expected().items()}
    want.update(skill_files())
    stale = generated_on_disk() - set(want)
    skills_dir = AUG / "skills"
    if skills_dir.is_dir():
        stale |= {f for f in skills_dir.rglob("*") if f.is_file()} - set(want)
    drift = [p for p, b in want.items() if not p.is_file() or p.read_bytes() != b]
    if check:
        for p in drift:
            print(f"漂移: {p.relative_to(ROOT)}")
        for p in sorted(stale):
            print(f"多余: {p.relative_to(ROOT)}")
        return 1 if drift or stale else 0
    for p in drift:
        p.parent.mkdir(parents=True, exist_ok=True)
        p.write_bytes(want[p])
    for p in stale:
        p.unlink()
    print(f"已同步 {len(want)} 个文件（更新 {len(drift)}，清理 {len(stale)}）")
    return 0


if __name__ == "__main__":
    sys.exit(main())
