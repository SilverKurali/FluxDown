#!/usr/bin/env python3
"""Auggie 钩子：在 PreToolUse / PostToolUse 复现 omp 的 TTSR 规则（.omp/rules/*.md）。

规则只维护 .omp/rules 一份；本脚本运行时直接读取其 frontmatter。
- interruptMode 非 never：PreToolUse 拒绝一次（exit 2，规则全文回传给模型），
  repeatGap 次工具调用内的原样重试放行（模拟 omp 的「打断后重试」）。
- interruptMode: never / astCondition：PostToolUse 以 additionalContext 提醒。
- 与 omp 的差异：auggie 钩子只能在工具调用前后触发，无法在模型输出流中途打断。
"""
import json
import os
import re
import sys
import tempfile
from pathlib import Path

# 没有合法例外的规则：每次命中都拒绝，不做「重试放行」。
ALWAYS_DENY = {"forbidden-commands"}
# 手写文件禁止编辑（应由命令重新生成）。
GENERATED = [
    "Cargo.lock", "**/bun.lock", "**/package-lock.json", "**/pnpm-lock.yaml", "**/yarn.lock",
    "website-v2/public/openapi.json", "website-v2/public/schemas/gpui-theme.v2.json",
    "website-v2/src/lib/gpui-theme/registry.json",
]
TOOLS = {"bash": "launch-process", "edit": "str-replace-editor", "write": "save-file"}
MAX_BODY = 6000


def unquote(v):
    v = v.strip()
    if len(v) >= 2 and v[0] == v[-1] == "'":
        return v[1:-1].replace("''", "'")
    if len(v) >= 2 and v[0] == v[-1] == '"':
        return v[1:-1]
    return v


def parse_rule(path):
    text = path.read_text(encoding="utf-8")
    m = re.match(r"---\r?\n(.*?)\r?\n---\r?\n?(.*)", text, re.S)
    if not m:
        return None
    meta, key = {}, None
    for line in m.group(1).splitlines():
        item = re.match(r"\s+-\s+(.*)", line)
        if item and key:
            meta.setdefault(key, []).append(unquote(item.group(1)))
            continue
        kv = re.match(r"([A-Za-z]+):\s*(.*)", line)
        if kv:
            key, val = kv.group(1), kv.group(2)
            meta[key] = unquote(val) if val else []
    as_list = lambda v: v if isinstance(v, list) else ([v] if v else [])
    scope = meta.get("scope") or "tool:edit,tool:write"
    tools = {TOOLS[s.strip()[5:]] for s in scope.split(",") if s.strip()[5:] in TOOLS}
    ast = meta.get("astCondition")
    return {
        "name": path.stem, "description": meta.get("description", ""), "body": m.group(2).strip(),
        "conditions": as_list(meta.get("condition")), "globs": as_list(meta.get("globs")),
        "ast": ast if isinstance(ast, str) else "", "tools": tools,
        # astCondition 只能降级为正则近似（分不清测试代码），因此只提醒不拦截。
        "interrupt": meta.get("interruptMode") != "never" and not ast
        and bool(as_list(meta.get("condition"))),
        "repeat": meta.get("repeatMode", "once"), "gap": int(meta.get("repeatGap", "3")),
    }


def glob_re(g):
    out, i, depth = "", 0, 0
    while i < len(g):
        c = g[i]
        if g.startswith("**/", i):
            out += "(?:.*/)?"; i += 3; continue
        if g.startswith("**", i):
            out += ".*"; i += 2; continue
        if c == "*":
            out += "[^/]*"
        elif c == "?":
            out += "[^/]"
        elif c == "{":
            out += "(?:"; depth += 1
        elif c == "}" and depth:
            out += ")"; depth -= 1
        elif c == "," and depth:
            out += "|"
        else:
            out += re.escape(c)
        i += 1
    return re.compile(out)


def is_glob(s):
    return not re.search(r"[\\()\[\]^$|+?]", s) and ("*" in s or "/" in s)


def glob_hit(globs, path):
    return path is not None and any(glob_re(g).fullmatch(path) for g in globs)


def is_test_code(path, content):
    return bool(re.search(r"(^|/)tests?/|_tests?\.rs$|(^|/)tests\.rs$", path or "")) or \
        "#[cfg(test)]" in content or "#[test]" in content


def matches(rule, tool, path, content):
    if tool not in rule["tools"]:
        return False
    if rule["globs"] and not glob_hit(rule["globs"], path):
        return False
    path_conds = [c for c in rule["conditions"] if is_glob(c)]
    regexes = [re.compile(c) for c in rule["conditions"] if not is_glob(c)]
    if not (path_conds or regexes or rule["ast"]):
        return True  # 只有 globs：命中路径即触发
    if glob_hit(path_conds, path):
        return True
    if any(r.search(content) or (path and r.search(path)) for r in regexes):
        return True
    if rule["ast"]:
        pat = re.escape(rule["ast"].replace("$E", "")).replace(r"unwrap", r"(?:unwrap|expect)")
        return bool(re.search(pat, content)) and not is_test_code(path, content)
    return False


def extract(tool, inp, root):
    if tool == "launch-process":
        return None, inp.get("command", "")
    path = str(inp.get("path", "")).replace("\\", "/")
    if os.path.isabs(path):
        try:
            path = Path(path).resolve().relative_to(Path(root).resolve()).as_posix()
        except ValueError:
            pass
    if tool == "save-file":
        return path, inp.get("file_content", "")
    return path, "\n".join(str(v) for k, v in inp.items() if k.startswith("new_str"))



def state_file(conv):
    safe = re.sub(r"[^A-Za-z0-9_-]", "_", conv or "default")
    return Path(tempfile.gettempdir()) / f"augment-ttsr-{safe}.json"


def load_state(conv):
    try:
        return json.loads(state_file(conv).read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return {"calls": 0, "fired": {}}


def save_state(conv, st):
    try:
        state_file(conv).write_text(json.dumps(st), encoding="utf-8")
    except OSError:
        pass  # 状态丢失只会让规则多提醒一次，不影响主流程


def should_fire(rule, st):
    last = st["fired"].get(rule["name"])
    if last is None:
        return True
    if rule["repeat"] != "after-gap":
        return False
    return st["calls"] - last >= rule["gap"]


def render(rule):
    body = rule["body"]
    if len(body) > MAX_BODY:
        body = body[:MAX_BODY] + "\n…（已截断，全文见 .omp/rules/%s.md）" % rule["name"]
    return f"[TTSR 规则 {rule['name']}] {rule['description']}\n\n{body}"


def main():
    ev = json.load(sys.stdin)
    phase, tool = ev.get("hook_event_name"), ev.get("tool_name", "")
    roots = ev.get("workspace_roots") or [os.getcwd()]
    root = Path(os.environ.get("AUGMENT_PROJECT_DIR") or roots[0])
    rules_dir = root / ".omp" / "rules"
    if tool not in TOOLS.values() or not rules_dir.is_dir():
        return 0
    conv = ev.get("conversation_id", "")
    st = load_state(conv)
    path, content = extract(tool, ev.get("tool_input") or {}, root)
    rules = [r for r in (parse_rule(p) for p in sorted(rules_dir.glob("*.md"))) if r]
    hits = [r for r in rules if matches(r, tool, path, content)]

    if phase == "PreToolUse":
        st["calls"] += 1
        denies = []
        if tool != "launch-process" and glob_hit(GENERATED, path):
            denies.append(f"{path} 是自动生成文件，禁止手改，请用对应的生成命令（见 AGENTS.md §2/§5）重新生成。")
        for r in hits:
            if r["interrupt"] and (r["name"] in ALWAYS_DENY or should_fire(r, st)):
                denies.append(render(r))
                st["fired"][r["name"]] = st["calls"]
        save_state(conv, st)
        if denies:
            sys.stderr.write("\n\n".join(denies) + "\n\n（已拦截本次调用；修正后重试）\n")
            return 2
    elif phase == "PostToolUse":
        notes = []
        for r in hits:
            if not r["interrupt"] and should_fire(r, st):
                notes.append(render(r))
                st["fired"][r["name"]] = st["calls"]
        save_state(conv, st)
        if notes:
            print(json.dumps({"hookSpecificOutput": {
                "hookEventName": "PostToolUse", "additionalContext": "\n\n".join(notes)}}))
    return 0


if __name__ == "__main__":
    try:
        sys.exit(main())
    except Exception as exc:  # 钩子自身故障不能阻塞会话
        sys.stderr.write(f"[ttsr hook] {exc!r}\n")
        sys.exit(1)
