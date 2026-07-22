#!/usr/bin/env python3
"""Standalone optional behavior scorer (stdlib only). Not wired into the Node CLI."""
from __future__ import annotations

import json
import re
import sys
from pathlib import Path

ACTION = re.compile(
    r"\b(fix|add|implement|create|update|remove|refactor|debug|test|verify|run)\b",
    re.I,
)
CONSTRAINT = re.compile(r"\b(must|should|only|without|never|ensure)\b", re.I)


def _coerce_prompts(prompts) -> list[str]:
    if not isinstance(prompts, list):
        return []
    real: list[str] = []
    for p in prompts:
        if isinstance(p, str):
            text = p.strip()
        elif p is None:
            continue
        else:
            text = str(p).strip()
        if text:
            real.append(text)
    return real


def score_prompts(prompts: list[str]) -> dict:
    real = _coerce_prompts(prompts)
    n = len(real)
    if n == 0:
        return {"fluency_score": 50, "archetype": "Sprinter", "real_prompt_count": 0}

    action = sum(1 for p in real if ACTION.search(p))
    constraint = sum(1 for p in real if CONSTRAINT.search(p))
    briefing = min(1.0, (action / n + constraint / n) / 0.4)
    fluency = int(50 + briefing * 50)
    archetype = "Architect" if briefing > 0.6 else "Collaborator"
    return {
        "fluency_score": fluency,
        "archetype": archetype,
        "real_prompt_count": n,
        "briefing": round(briefing, 3),
    }


def main() -> int:
    if len(sys.argv) < 2:
        print("Usage: behavior.py <prompts.json>", file=sys.stderr)
        return 1
    path = Path(sys.argv[1])
    try:
        data = json.loads(path.read_text(encoding="utf-8"))
    except OSError as err:
        print(f"error: cannot read {path}: {err}", file=sys.stderr)
        return 1
    except json.JSONDecodeError as err:
        print(f"error: invalid JSON in {path}: {err}", file=sys.stderr)
        return 1
    prompts = data if isinstance(data, list) else data.get("prompts", [])
    result = score_prompts(prompts if isinstance(prompts, list) else [])
    print(json.dumps(result, indent=2))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
