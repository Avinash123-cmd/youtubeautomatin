#!/usr/bin/env python3
"""Operator smoke test: HTTP success AND a valid service readiness document required."""
import json
import os
import sys
from urllib.request import urlopen


def check(name, url):
    try:
        with urlopen(url, timeout=10) as response:
            body = json.load(response)
        if body.get("status") != "ok":
            raise ValueError("service reports not ready")
        if name == "api":
            checks = body.get("checks", [])
            statuses = {item.get("component"): item.get("status") for item in checks}
            if any(statuses.get(component) != "healthy" for component in ("postgres", "redis")):
                raise ValueError("database/Redis readiness not confirmed")
        print(f"  ok    {name}")
        return True
    except Exception:
        # Do not emit credentials, internal URLs or error bodies from an upstream proxy.
        print(f"  FAIL  {name}: readiness not confirmed")
        return False


def main():
    checks = [
        ("api", os.getenv("API_BASE", "http://127.0.0.1:4000") + "/api/system/health"),
        ("ai-engine", os.getenv("AI_BASE", "http://127.0.0.1:8100") + "/health"),
        ("video-processor", os.getenv("VP_BASE", "http://127.0.0.1:8200") + "/health"),
    ]
    print("ClipForge readiness")
    results = [check(name, url) for name, url in checks]
    return 0 if all(results) else 1


if __name__ == "__main__":
    sys.exit(main())
