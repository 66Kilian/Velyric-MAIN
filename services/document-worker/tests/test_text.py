from __future__ import annotations

from velyric_document_worker.text import (
    Section,
    chunk_sections,
    detect_language,
    detect_pii,
    estimate_tokens,
    normalize,
)


def test_normalize_collapses_whitespace_and_control_characters() -> None:
    raw = "Nyitvatartás:\u00a0\u00a0hétfő\x00\r\n\r\n\r\n\r\nkedd\t\tszerda"
    assert normalize(raw) == "Nyitvatartás: hétfő\n\nkedd szerda"


def test_chunks_respect_target_size_heading_and_overlap() -> None:
    paragraphs = [
        f"A(z) {index}. bekezdés a rendelő házirendjéről szól, és pontosan leírja a teendőket."
        for index in range(40)
    ]
    sections = [Section(heading_path=("Házirend", "Érkezés"), text="\n\n".join(paragraphs), page=3)]
    chunks = chunk_sections(sections, target_tokens=120, overlap_tokens=30, max_chars=900)
    assert len(chunks) > 3
    assert [chunk.index for chunk in chunks] == list(range(len(chunks)))
    for chunk in chunks:
        assert chunk.content.startswith("Házirend / Érkezés\n")
        assert len(chunk.content) <= 900
        assert chunk.page == 3
        assert chunk.token_count == estimate_tokens(chunk.content)
    first_body = chunks[0].content.split("\n")[1:]
    second_body = chunks[1].content.split("\n")[1:]
    assert first_body[-1] == second_body[0]


def test_oversized_sentences_are_split_without_losing_text() -> None:
    sentence = "szó " * 3000
    chunks = chunk_sections(
        [Section(heading_path=(), text=sentence.strip())],
        target_tokens=200,
        overlap_tokens=0,
        max_chars=1000,
    )
    assert all(len(chunk.content) <= 1000 for chunk in chunks)
    assert sum(chunk.content.count("szó") for chunk in chunks) == 3000


def test_language_detection_distinguishes_supported_languages() -> None:
    assert (
        detect_language(
            "A rendelő hétfőtől péntekig van nyitva, és a parkolás az udvarban ingyenes, de csak ha van hely."
        )
        == "hu"
    )
    assert (
        detect_language(
            "Die Praxis ist von Montag bis Freitag geöffnet und das Parken ist im Hof für alle Patienten kostenlos."
        )
        == "de"
    )
    assert (
        detect_language(
            "The clinic is open from Monday to Friday and parking in the yard is free for all of your visits."
        )
        == "en"
    )
    assert detect_language("12345 67890") is None


def test_pii_detection_uses_checksums_to_avoid_false_positives() -> None:
    assert detect_pii("Írjon a recepcio@rendelo.hu címre vagy hívja a +36 30 123 4567 számot.") == (
        "EMAIL",
        "PHONE",
    )
    assert detect_pii("Adószám: 12345678-2-41") == ("HU_TAX_NUMBER",)
    assert detect_pii("Kártya: 4111 1111 1111 1111") == ("PAYMENT_CARD",)
    assert detect_pii("Rendelési azonosító: 4111 1111 1111 1112") == ()
    assert detect_pii("TAJ: 111 111 110") == ("HU_SOCIAL_SECURITY_NUMBER",)
    assert detect_pii("Szobaszám 123 456 789") == ()
