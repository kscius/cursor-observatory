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


def score_prompts(prompts: list[str]) -> dict:
    real = [p.strip() for p in prompts if p and p.strip()]
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
    data = json.loads(Path(sys.argv[1]).read_text(encoding="utf-8"))
    result = score_prompts(data if isinstance(data, list) else data.get("prompts", []))
    print(json.dumps(result, indent=2))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
