"""Tests for the Gemini JSON generation boundary."""

import json

import pytest

from ai_client import GeminiJsonClient, load_ai_env


def test_load_ai_env_reads_mcp_server_env(monkeypatch):
    monkeypatch.delenv("GEMINI_API_KEY", raising=False)
    monkeypatch.delenv("GEMINI_MODEL", raising=False)

    load_ai_env()

    assert "GEMINI_API_KEY" in __import__("os").environ
    assert __import__("os").environ.get("GEMINI_MODEL") == "gemini-2.5-flash"


def test_gemini_json_client_posts_json_request(monkeypatch):
    captured = {}

    class FakeResponse:
        def __enter__(self):
            return self

        def __exit__(self, *_args):
            return None

        def read(self):
            return json.dumps(
                {
                    "candidates": [
                        {
                            "content": {
                                "parts": [{"text": '{"message":"Hallo Anna","tone":"friendly"}'}]
                            }
                        }
                    ],
                    "usageMetadata": {"totalTokenCount": 42},
                }
            ).encode()

    def fake_urlopen(request, timeout):
        captured["url"] = request.full_url
        captured["payload"] = json.loads(request.data.decode())
        captured["timeout"] = timeout
        return FakeResponse()

    monkeypatch.setattr("ai_client.urllib.request.urlopen", fake_urlopen)
    client = GeminiJsonClient(api_key="test-key", model="gemini-test")

    result = client.generate_json(
        [
            {"role": "system", "content": "Nur JSON."},
            {"role": "user", "content": "Sag hallo."},
        ],
        temperature=0.2,
    )

    assert "models/gemini-test:generateContent" in captured["url"]
    assert captured["payload"]["generationConfig"]["responseMimeType"] == "application/json"
    assert captured["payload"]["generationConfig"]["temperature"] == 0.2
    assert captured["payload"]["contents"][0]["parts"][0]["text"].startswith("SYSTEM:")
    assert result.data == {"message": "Hallo Anna", "tone": "friendly"}
    assert result.total_tokens == 42


def test_gemini_json_client_rejects_missing_json(monkeypatch):
    class FakeResponse:
        def __enter__(self):
            return self

        def __exit__(self, *_args):
            return None

        def read(self):
            return json.dumps(
                {"candidates": [{"content": {"parts": [{"text": "not json"}]}}]}
            ).encode()

    monkeypatch.setattr("ai_client.urllib.request.urlopen", lambda *_args, **_kwargs: FakeResponse())
    client = GeminiJsonClient(api_key="test-key", model="gemini-test")

    with pytest.raises(ValueError, match="valid JSON"):
        client.generate_json([{"role": "user", "content": "bad"}])


def test_gemini_json_client_rejects_max_token_truncation(monkeypatch):
    class FakeResponse:
        def __enter__(self):
            return self

        def __exit__(self, *_args):
            return None

        def read(self):
            return json.dumps(
                {
                    "candidates": [
                        {
                            "finishReason": "MAX_TOKENS",
                            "content": {"parts": [{"text": '{"message":"Hallo'}]},
                        }
                    ]
                }
            ).encode()

    monkeypatch.setattr("ai_client.urllib.request.urlopen", lambda *_args, **_kwargs: FakeResponse())
    client = GeminiJsonClient(api_key="test-key", model="gemini-test")

    with pytest.raises(ValueError, match="max output tokens"):
        client.generate_json([{"role": "user", "content": "too long"}])
