"""Strict persona matching against the three seeded personas.

Per the user's PR A approval (Adjustment 1): false positives on stage are
worse than false negatives. The mobile UI handles "unmatched" gracefully
via the persona picker — so we lean strict here.

Match rules (in evaluation order):
  1. Match if transcript contains the FULL FIRST NAME of a persona
     (case-insensitive, token-aware).
     - "mama risikat" is the canonical first name for mama_risikat
     - "iya tope" is the canonical first name for iya_tope
     - "kosi" is the canonical first name for kosi
  2. Match if transcript contains FIRST + LAST in any order
     (already covered by rule 1 since first-name match is sufficient,
     but `risikat oluwole` without "mama" still matches via rule 3).
  3. Match on UNIQUE LAST NAME — surnames are unambiguous across our
     three personas, so `risikat`, `oluwole`, `adeyemi`, or `eze`
     resolves to the right persona even without the first name.

Rules that MUST NOT trigger a match:
  - "mama" alone (common Yoruba honorific — too ambiguous)
  - "iya" alone (also a Yoruba honorific)
  - "tope" alone (partial first name — could be many people)

Persona data is kept in sync with `seed.py` and
`mobile/constants/personas.ts`.
"""

from __future__ import annotations

import re
from dataclasses import dataclass


@dataclass(frozen=True)
class PersonaSpec:
    """Subset of seed.py PERSONAS needed for matching."""

    persona_id: str
    customer_identifier: str
    # Token-aware: "mama risikat" matches as the full first name only when
    # the transcript contains both tokens, in order, with whitespace.
    first_name_tokens: tuple[str, ...]
    last_name_tokens: tuple[str, ...]
    # Singleton tokens that uniquely identify this persona when present
    # in the transcript — typically the trader's actual given name (the
    # non-honorific part of a compound first name) plus the surname.
    # Per user's strict rule (Adjustment 1): "tope" alone is INTENTIONALLY
    # excluded from iya_tope's distinguishing set because Whisper noise on
    # the more common syllable makes false positives too likely on stage.
    distinguishing_tokens: tuple[str, ...]


# Mirrors backend/seed.py and mobile/constants/personas.ts.
PERSONAS: tuple[PersonaSpec, ...] = (
    PersonaSpec(
        persona_id="mama_risikat",
        customer_identifier="mama_risikat_001",
        # "Mama Risikat" — "Mama" is honorific, "Risikat" is the given name
        first_name_tokens=("mama", "risikat"),
        last_name_tokens=("oluwole",),
        # Risikat (her given name within the compound first) is unique
        # across our personas; Oluwole is unique as a surname.
        distinguishing_tokens=("risikat", "oluwole"),
    ),
    PersonaSpec(
        persona_id="iya_tope",
        customer_identifier="iya_tope_002",
        # "Iya Tope" — "Iya" is honorific, "Tope" is the given name
        first_name_tokens=("iya", "tope"),
        last_name_tokens=("adeyemi",),
        # User explicitly rejected "tope" alone (Adjustment 1) — too
        # common in Yoruba names, Whisper noise = false positives.
        # Only the surname is in the distinguishing set.
        distinguishing_tokens=("adeyemi",),
    ),
    PersonaSpec(
        persona_id="kosi",
        customer_identifier="kosi_003",
        first_name_tokens=("kosi",),
        last_name_tokens=("eze",),
        # "kosi" already matches via first_name; surname is the extra ID.
        distinguishing_tokens=("eze",),
    ),
)

# Honorifics + common partial tokens that MUST NOT match on their own.
# Looked up only to disqualify single-token transcripts; multi-token
# transcripts pass through the normal rule path.
_BARRED_LONE_TOKENS = frozenset({"mama", "iya"})


def _tokenize(transcript: str) -> list[str]:
    # Split on any non-alphanumeric. Strip empties. Lowercase.
    return [t.lower() for t in re.split(r"[^A-Za-z0-9]+", transcript) if t]


def _has_consecutive(tokens: list[str], needles: tuple[str, ...]) -> bool:
    """True if `tokens` contains `needles` as a consecutive run."""
    if not needles:
        return False
    n = len(needles)
    for i in range(len(tokens) - n + 1):
        if tuple(tokens[i : i + n]) == needles:
            return True
    return False


def match_persona(transcript: str) -> PersonaSpec | None:
    """Return the matched PersonaSpec or None.

    Strict rules — see module docstring.
    """
    if not transcript or not transcript.strip():
        return None

    tokens = _tokenize(transcript)
    if not tokens:
        return None

    # Disqualify single-honorific transcripts: "mama" alone, "iya" alone.
    # These would otherwise NEVER match anyway because mama_risikat's
    # first_name_tokens is ("mama", "risikat") — but documenting the
    # intent makes the rule survive future persona additions where a
    # bare honorific might accidentally become a valid first_name.
    if len(tokens) == 1 and tokens[0] in _BARRED_LONE_TOKENS:
        return None

    # Rule 1: full first name as a consecutive token run.
    for p in PERSONAS:
        if _has_consecutive(tokens, p.first_name_tokens):
            return p

    # Rule 2: any distinguishing token (given-name component or surname).
    # Note "tope" is NOT in iya_tope's distinguishing set — that exclusion
    # is the load-bearing piece of Adjustment 1.
    token_set = set(tokens)
    for p in PERSONAS:
        if any(t in token_set for t in p.distinguishing_tokens):
            return p

    return None
