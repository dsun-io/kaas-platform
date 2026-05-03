"""导出 OpenAPI JSON 供前端 openapi-typescript 消费"""
import json
import os
from pathlib import Path
from app.main import app

OUTPUT_DIR = Path(__file__).resolve().parent.parent / "docs"
OUTPUT_DIR.mkdir(parents=True, exist_ok=True)
OUTPUT_FILE = OUTPUT_DIR / "openapi.json"

schema = app.openapi()
with open(OUTPUT_FILE, "w", encoding="utf-8") as f:
    json.dump(schema, f, indent=2, ensure_ascii=False)

print(f"Exported {len(schema['paths'])} paths to {OUTPUT_FILE}")
