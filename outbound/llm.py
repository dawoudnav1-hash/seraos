"""Thin wrapper around the Anthropic SDK: refusal fallbacks, pause_turn, structured parsing."""

from __future__ import annotations

import logging
from functools import lru_cache
from typing import TypeVar

import anthropic
from pydantic import BaseModel

log = logging.getLogger(__name__)

# Server-side fallback: if the model's safety classifier declines, the API re-runs the
# request on Anthropic's recommended fallback model instead of returning a refusal.
FALLBACK_BETA = "server-side-fallback-2026-07-01"

T = TypeVar("T", bound=BaseModel)


class LLMError(RuntimeError):
    pass


@lru_cache(maxsize=1)
def client() -> anthropic.Anthropic:
    # Research turns with web search can run for minutes.
    return anthropic.Anthropic(timeout=900.0, max_retries=4)


def _check(resp) -> None:
    if resp.stop_reason == "refusal":
        detail = getattr(resp, "stop_details", None)
        raise LLMError(f"model declined: {getattr(detail, 'category', None)} {getattr(detail, 'explanation', '')}")
    if resp.stop_reason == "max_tokens":
        raise LLMError("response hit max_tokens")


def run_with_server_tools(*, model: str, system: str, prompt: str, tools: list[dict], effort: str,
                          max_tokens: int = 32000, max_continuations: int = 6):
    """One agentic turn using server tools (web search / fetch). Handles pause_turn.

    Returns the list of all assistant content blocks across continuations.
    """
    messages: list[dict] = [{"role": "user", "content": prompt}]
    blocks: list = []
    for _ in range(max_continuations + 1):
        with client().beta.messages.stream(
            model=model,
            max_tokens=max_tokens,
            system=system,
            messages=messages,
            tools=tools,
            thinking={"type": "adaptive"},
            output_config={"effort": effort},
            betas=[FALLBACK_BETA],
            fallbacks="default",
        ) as stream:
            resp = stream.get_final_message()
        blocks.extend(resp.content)
        if resp.stop_reason == "pause_turn":
            messages.append({"role": "assistant", "content": resp.content})
            continue
        _check(resp)
        return blocks
    raise LLMError("research turn still paused after max continuations")


def parse(*, model: str, system: str, prompt: str, schema: type[T], effort: str,
          max_tokens: int = 16000) -> T:
    """Single call that returns a validated pydantic object."""
    resp = client().beta.messages.parse(
        model=model,
        max_tokens=max_tokens,
        system=system,
        messages=[{"role": "user", "content": prompt}],
        output_format=schema,
        thinking={"type": "adaptive"},
        output_config={"effort": effort},
        betas=[FALLBACK_BETA],
        fallbacks="default",
    )
    _check(resp)
    out = resp.parsed_output
    if out is None:
        raise LLMError("model returned no parsable output")
    return out
