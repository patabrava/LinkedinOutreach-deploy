"""Gemini JSON generation helper for outreach draft agents."""

from __future__ import annotations

import json
import os
import re
import urllib.parse
import urllib.request
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Dict, List, Optional

from dotenv import load_dotenv


DEFAULT_GEMINI_MODEL = "gemini-2.5-flash"


@dataclass
class JsonGenerationResult:
    data: Dict[str, Any]
    raw_text: str
    total_tokens: Optional[int] = None


def load_ai_env() -> None:
    """Load local env files used by the spawned Python draft agents."""
    here = Path(__file__).resolve().parent
    repo_root = here.parent
    for env_path in [
        here / ".env",
        repo_root / "apps" / "web" / ".env",
        repo_root / ".env",
    ]:
        if env_path.exists():
            load_dotenv(env_path, override=False)


def get_gemini_model() -> str:
    return os.getenv("GEMINI_MODEL", DEFAULT_GEMINI_MODEL).strip() or DEFAULT_GEMINI_MODEL


def create_json_client() -> "GeminiJsonClient":
    load_ai_env()
    api_key = os.getenv("GEMINI_API_KEY", "").strip()
    if not api_key:
        raise RuntimeError("GEMINI_API_KEY not set")
    return GeminiJsonClient(api_key=api_key, model=get_gemini_model())


class GeminiJsonClient:
    """Minimal Gemini REST client that returns parsed JSON objects."""

    def __init__(self, *, api_key: str, model: str = DEFAULT_GEMINI_MODEL) -> None:
        self.api_key = api_key
        self.model = model

    def generate_json(
        self,
        messages: List[Dict[str, str]],
        *,
        temperature: float = 0.7,
        max_output_tokens: int = 800,
        timeout: int = 60,
    ) -> JsonGenerationResult:
        body = {
            "contents": [
                {
                    "parts": [
                        {
                            "text": self._messages_to_text(messages),
                        }
                    ]
                }
            ],
            "generationConfig": {
                "responseMimeType": "application/json",
                "temperature": temperature,
                "maxOutputTokens": max_output_tokens,
            },
        }
        url = (
            "https://generativelanguage.googleapis.com/v1beta/models/"
            f"{urllib.parse.quote(self.model, safe='')}:generateContent"
            f"?key={urllib.parse.quote(self.api_key, safe='')}"
        )
        request = urllib.request.Request(
            url,
            data=json.dumps(body).encode("utf-8"),
            headers={"Content-Type": "application/json"},
            method="POST",
        )

        with urllib.request.urlopen(request, timeout=timeout) as response:
            payload = json.loads(response.read().decode("utf-8"))

        text = self._extract_text(payload)
        finish_reason = (((payload.get("candidates") or [{}])[0]) or {}).get("finishReason")
        if finish_reason == "MAX_TOKENS":
            raise ValueError(f"Gemini response hit max output tokens before valid JSON: {text[:200]}")
        return JsonGenerationResult(
            data=self._parse_json_object(text),
            raw_text=text,
            total_tokens=(payload.get("usageMetadata") or {}).get("totalTokenCount"),
        )

    @staticmethod
    def _messages_to_text(messages: List[Dict[str, str]]) -> str:
        parts: List[str] = []
        for message in messages:
            role = (message.get("role") or "user").upper()
            content = (message.get("content") or "").strip()
            if content:
                parts.append(f"{role}:\n{content}")
        return "\n\n".join(parts)

    @staticmethod
    def _extract_text(payload: Dict[str, Any]) -> str:
        candidates = payload.get("candidates") or []
        if not candidates:
            raise ValueError(f"Gemini returned no candidates: {str(payload)[:300]}")
        parts = ((candidates[0].get("content") or {}).get("parts") or [])
        text = "".join(str(part.get("text") or "") for part in parts).strip()
        if not text:
            raise ValueError(f"Gemini returned empty text: {str(payload)[:300]}")
        return text

    @staticmethod
    def _parse_json_object(text: str) -> Dict[str, Any]:
        try:
            parsed = json.loads(text)
        except json.JSONDecodeError:
            match = re.search(r"\{.*\}", text, re.DOTALL)
            if not match:
                raise ValueError(f"Gemini response did not contain valid JSON: {text[:200]}")
            parsed = json.loads(match.group())
        if not isinstance(parsed, dict):
            raise ValueError("Gemini JSON response must be an object")
        return parsed
