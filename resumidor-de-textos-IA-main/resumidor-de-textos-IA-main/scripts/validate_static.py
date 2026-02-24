#!/usr/bin/env python3
"""Validates that local assets referenced by index.html exist on disk."""

from __future__ import annotations

from html.parser import HTMLParser
from pathlib import Path
from urllib.parse import urlsplit


ROOT = Path(__file__).resolve().parent.parent
PUBLIC_DIR = ROOT / "simplify" / "public"
ENTRYPOINT = PUBLIC_DIR / "index.html"


class AssetCollector(HTMLParser):
    def __init__(self) -> None:
        super().__init__()
        self.references: list[tuple[str, int]] = []
        self._line = 1

    def feed(self, data: str) -> None:  # noqa: D401 - we keep tracking line number.
        for idx, line in enumerate(data.splitlines(), start=1):
            self._line = idx
            super().feed(line + "\n")

    def handle_starttag(self, tag: str, attrs: list[tuple[str, str | None]]) -> None:
        attrs_dict = dict(attrs)
        for key in ("src", "href"):
            value = attrs_dict.get(key)
            if value:
                self.references.append((value, self._line))


def normalize_ref(ref: str) -> str | None:
    parsed = urlsplit(ref)
    if parsed.scheme or ref.startswith("#"):
        return None
    if ref.startswith(("mailto:", "tel:", "javascript:")):
        return None
    path = parsed.path.strip()
    if not path:
        return None
    return path


def resolve_path(path_ref: str) -> Path:
    if path_ref.startswith("/"):
        return PUBLIC_DIR / path_ref.lstrip("/")
    return (ENTRYPOINT.parent / path_ref).resolve()


def main() -> int:
    if not ENTRYPOINT.exists():
        print(f"[ERROR] No existe entrypoint: {ENTRYPOINT}")
        return 1

    parser = AssetCollector()
    parser.feed(ENTRYPOINT.read_text(encoding="utf-8"))

    missing: list[tuple[int, str, Path]] = []
    for raw, line in parser.references:
        normalized = normalize_ref(raw)
        if normalized is None:
            continue
        target = resolve_path(normalized)
        if not target.exists():
            missing.append((line, raw, target))

    if missing:
        print("[ERROR] Referencias locales faltantes:")
        for line, raw, target in missing:
            print(f"  - Línea {line}: {raw} -> {target}")
        return 1

    print("[OK] Todas las referencias locales existen.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
