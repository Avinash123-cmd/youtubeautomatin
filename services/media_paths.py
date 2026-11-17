"""Filesystem boundary for authenticated media RPCs.

Workers and Python services must mount WORK_DIR at the same absolute path.
Paths are files, never URLs/protocols, and resolved symlinks must remain in WORK_DIR.
"""
from pathlib import Path
from fastapi import HTTPException


def media_path(value: str, work_dir: str, *, output: bool = False) -> str:
    root = Path(work_dir).resolve()
    candidate = Path(value)
    if not candidate.is_absolute():
        raise HTTPException(status_code=422, detail={'code': 'INVALID_MEDIA_PATH', 'message': 'Media paths must be absolute files within WORK_DIR'})
    resolved = candidate.resolve()
    if resolved == root or not resolved.is_relative_to(root):
        raise HTTPException(status_code=422, detail={'code': 'INVALID_MEDIA_PATH', 'message': 'Media paths must remain within WORK_DIR'})
    if not output and not resolved.is_file():
        raise HTTPException(status_code=422, detail={'code': 'MEDIA_NOT_FOUND', 'message': 'Media file is unavailable in the shared work directory'})
    return str(resolved)
