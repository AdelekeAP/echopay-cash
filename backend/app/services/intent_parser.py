"""Intent extraction from voice transcripts.

Two-stage pipeline:
  1. Fast-path (pure Python, <1ms) — regex for balance/cancel keywords,
     then persona_match for transfer recipients + digit/word amount parsing.
  2. LLM fallback (GPT-4o-mini) — only triggered when fast-path returns
     unknown. Gracefully skipped when OPENAI_API_KEY is empty.

Designed for the three seeded EchoPay Cash personas:
  mama_risikat, iya_tope, kosi

All amounts stored/returned in kobo (₦1 = 100 kobo).

`parse_intent` is async because the LLM fallback path uses async OpenAI.
Fast-path cases never await anything.
"""

from __future__ import annotations

import json
import logging
import re
from dataclasses import dataclass, field

from ..core.config import get_settings
from ..voice.persona_match import match_persona

logger = logging.getLogger("echopay.intent_parser")


@dataclass
class IntentResult:
    intent: str   # 'transfer' | 'balance' | 'cancel' | 'unknown'
    action: str   # 'transfer_local' | 'balance' | 'cancel' | 'unknown'
    entities: dict = field(default_factory=dict)


# ----------------------------------------------------------------- regex

_BALANCE_RE = re.compile(
    r"\b(balance|balan[cs]e|how much|account balance|my balance|"
    r"how much.{0,15}account|check.{0,10}balance)\b",
    re.IGNORECASE,
)
_CANCEL_RE = re.compile(
    r"\b(cancel|stop|abort|never mind|nevermind)\b",
    re.IGNORECASE,
)
# PRD §1 Script A 2:00 beat — "Generate ₦200 QR for okra." Trigger words
# "generate/create/make/get me" + "QR" are distinctive enough to avoid
# false positives on the persona+amount fast-path (no transfer phrasing
# contains "QR"). Runs BEFORE persona match for the same reason.
_QR_GENERATE_RE = re.compile(
    r"\b(generate|create|make|get me)\b.{0,20}\b(qr|q\.?r|cue arr)\b",
    re.IGNORECASE,
)
_DIGIT_AMOUNT_RE = re.compile(r"\b(\d[\d,]*)\b")

# ----------------------------------------------------------------- spoken-number lookup

_WORD_DIGITS: dict[str, int] = {
    "zero": 0, "one": 1, "two": 2, "three": 3, "four": 4, "five": 5,
    "six": 6, "seven": 7, "eight": 8, "nine": 9, "ten": 10,
    "eleven": 11, "twelve": 12, "thirteen": 13, "fourteen": 14, "fifteen": 15,
    "sixteen": 16, "seventeen": 17, "eighteen": 18, "nineteen": 19,
    "twenty": 20, "thirty": 30, "forty": 40, "fifty": 50,
    "sixty": 60, "seventy": 70, "eighty": 80, "ninety": 90,
}
_MULTIPLIERS: dict[str, int] = {
    "hundred": 100,
    "thousand": 1_000,
    "million": 1_000_000,
    # Pidgin K-suffix as a spoken word — "send five K" → 5000. The
    # digit form ("5K") is normalized to "5000" earlier in
    # _preprocess_transcript() before tokenization, so this only
    # catches the word form.
    "k": 1_000,
}

# ----------------------------------------------------------------- LLM prompt

_LLM_SYSTEM = (
    "You extract payment intents for a Nigerian market-women mobile wallet.\n"
    "Known recipients (use exact IDs): mama_risikat, iya_tope, kosi.\n"
    "Return ONLY valid JSON — no markdown, no explanation:\n"
    '{"intent":"transfer"|"balance"|"qr_generate"|"unknown",'
    '"recipientId":"mama_risikat"|"iya_tope"|"kosi"|null,'
    '"amountNaira":number|null}\n'
    "Examples:\n"
    '- "send 5000 to iya tope" → {"intent":"transfer","recipientId":"iya_tope","amountNaira":5000}\n'
    '- "pay kosi two hundred naira" → {"intent":"transfer","recipientId":"kosi","amountNaira":200}\n'
    '- "generate 500 QR" → {"intent":"qr_generate","recipientId":null,"amountNaira":500}\n'
    '- "make a QR for 200 naira" → {"intent":"qr_generate","recipientId":null,"amountNaira":200}\n'
    '- "what is my balance" → {"intent":"balance","recipientId":null,"amountNaira":null}\n'
    '- "hello" → {"intent":"unknown","recipientId":null,"amountNaira":null}'
)


# ----------------------------------------------------------------- preprocessing

# Politeness markers that prefix Pidgin commands — strip from the start
# so downstream regex matches the intent verb directly. Includes "biko"
# (Igbo "please") since mixed-code is common in Nigerian markets.
_POLITENESS_PREFIX_RE = re.compile(
    r"^(abeg|please|biko|sir|madam|ma'am|ma)\s+",
    re.IGNORECASE,
)
# Whisper occasionally inserts a period between adjacent words on
# Pidgin transcripts ("I.dey", "make.i"). Restore the space.
_PERIOD_INTRUSION_RE = re.compile(r"(\w)\.(\w)")
# K-suffix on digit amounts: "5K", "10 k", "10K" → "5000", "10000".
# Tested negative case: "iyaK" (no word-boundary at start) won't match.
_K_SUFFIX_RE = re.compile(r"\b(\d+)\s*[kK]\b")


def _preprocess_transcript(text: str) -> str:
    """Normalize Whisper artifacts + strip Pidgin politeness markers.

    Pure MECHANICAL fixes — no semantic rewriting. Downstream regex,
    persona match, and LLM layers handle Pidgin grammar. We deliberately
    do NOT rewrite "give" → "to" here because "Give Iya 5000 naira"
    uses give as the main verb, not a preposition.

    Order matters: smart-quote → period-intrusion → hyphen-artifact →
    K-suffix → politeness-strip → whitespace-normalize.
    """
    s = text.lower()
    # Smart quotes that Whisper sometimes emits.
    s = s.replace("‘", "'").replace("’", "'")
    s = s.replace("“", '"').replace("”", '"')
    # Period intrusion between words.
    s = _PERIOD_INTRUSION_RE.sub(r"\1 \2", s)
    # Hyphen artifacts on common Pidgin markers.
    s = re.sub(r"\bmake-i\b", "make i", s)
    s = re.sub(r"\bno-mind\b", "no mind", s)
    # K-suffix on digit amounts. Done BEFORE politeness strip so the
    # regex word-boundary still works on a leading "abeg 5K ...".
    s = _K_SUFFIX_RE.sub(r"\g<1>000", s)
    # Strip leading politeness markers (one occurrence at start only —
    # don't get aggressive, "abeg" inside the transcript may be load-
    # bearing context for the LLM).
    s = _POLITENESS_PREFIX_RE.sub("", s)
    # Whitespace normalization last.
    s = re.sub(r"\s+", " ", s).strip()
    return s


# ----------------------------------------------------------------- helpers


def _tokenize(text: str) -> list[str]:
    return [t.lower() for t in re.split(r"[^A-Za-z0-9]+", text) if t]


def _digit_amount_naira(text: str) -> int | None:
    m = _DIGIT_AMOUNT_RE.search(text)
    if m:
        try:
            return int(m.group(1).replace(",", ""))
        except ValueError:
            return None
    return None


def _word_amount_naira(tokens: list[str]) -> int | None:
    """Accumulate spoken English number words into a naira integer."""
    current = 0
    total = 0
    found = False
    for t in tokens:
        if t in _WORD_DIGITS:
            current += _WORD_DIGITS[t]
            found = True
        elif t in _MULTIPLIERS:
            mult = _MULTIPLIERS[t]
            if mult == 100:
                current = (current if current else 1) * 100
            else:
                total += (current if current else 1) * mult
                current = 0
            found = True
    total += current
    return total if (found and total > 0) else None


def _amount_kobo(transcript: str) -> int | None:
    tokens = _tokenize(transcript)
    naira = _digit_amount_naira(transcript) or _word_amount_naira(tokens)
    return naira * 100 if naira is not None else None


async def _llm_fallback(transcript: str) -> IntentResult | None:
    """Single GPT-4o-mini call. Returns None on any error."""
    try:
        from openai import AsyncOpenAI  # noqa: WPS433 — late import avoids hard dep

        key = get_settings().openai_api_key
        if not key:
            return None

        client = AsyncOpenAI(api_key=key)
        resp = await client.chat.completions.create(
            model="gpt-4o-mini",
            temperature=0,
            response_format={"type": "json_object"},
            messages=[
                {"role": "system", "content": _LLM_SYSTEM},
                {"role": "user", "content": transcript},
            ],
        )
        raw = resp.choices[0].message.content or "{}"
        data = json.loads(raw)
    except Exception as exc:  # noqa: BLE001
        logger.warning("llm_fallback failed: %s", exc)
        return None

    intent = data.get("intent", "unknown")
    if intent not in ("transfer", "balance", "qr_generate", "unknown"):
        intent = "unknown"

    entities: dict = {}
    recipient_id = data.get("recipientId") or None
    if recipient_id in ("mama_risikat", "iya_tope", "kosi"):
        entities["recipientId"] = recipient_id

    amount_naira = data.get("amountNaira")
    if isinstance(amount_naira, (int, float)) and amount_naira > 0:
        entities["amountKobo"] = int(amount_naira * 100)

    action = "transfer_local" if intent == "transfer" else intent
    return IntentResult(intent=intent, action=action, entities=entities)


# ----------------------------------------------------------------- public API


async def parse_intent(transcript: str) -> IntentResult:
    """Extract intent from a voice transcript. Never raises.

    Returns an IntentResult with intent='unknown' when the transcript
    can't be classified. Callers should always check `.action`.

    Pidgin support: the transcript goes through _preprocess_transcript
    first to normalize Whisper artifacts (smart quotes, period
    intrusions, K-suffix on amounts) and strip leading politeness
    markers (abeg, please, biko, sir, ma). Pidgin grammar is handled
    further down: in the regex extensions for balance/cancel/qr_generate,
    in match_persona's tokenizer, and in the LLM few-shot examples.
    """
    if not transcript or not transcript.strip():
        return IntentResult(intent="unknown", action="unknown", entities={})

    transcript = _preprocess_transcript(transcript)

    # 1. Balance fast-path
    if _BALANCE_RE.search(transcript):
        return IntentResult(intent="balance", action="balance", entities={})

    # 2. Cancel fast-path
    if _CANCEL_RE.search(transcript):
        return IntentResult(intent="cancel", action="cancel", entities={})

    # 3a. QR-generate fast-path. Must run BEFORE persona match so phrasing
    # like "generate ₦200 QR for okra" (where "for okra" is a memo, not a
    # recipient) doesn't get hijacked by a future persona-token bleed.
    if _QR_GENERATE_RE.search(transcript):
        entities: dict = {}
        amt = _amount_kobo(transcript)
        if amt:
            entities["amountKobo"] = amt
        return IntentResult(
            intent="qr_generate", action="qr_generate", entities=entities
        )

    # 3b. Persona match + amount (no API call)
    persona = match_persona(transcript)
    if persona:
        entities: dict = {"recipientId": persona.persona_id}
        amt = _amount_kobo(transcript)
        if amt:
            entities["amountKobo"] = amt
        return IntentResult(intent="transfer", action="transfer_local", entities=entities)

    # 4. LLM fallback for complex phrasing (e.g. "I want to pay Kosi twenty naira")
    llm_result = await _llm_fallback(transcript)
    if llm_result:
        return llm_result

    return IntentResult(intent="unknown", action="unknown", entities={})
