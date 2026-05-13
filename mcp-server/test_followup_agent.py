"""Tests for reply follow-up prompt construction and text cleanup."""

from run_followup_agent import build_followup_prompt, sanitize_message


def test_prompt_includes_sequence_style_and_reply_relation_rules():
    prompt = build_followup_prompt(
        {
            "first_name": "Anna",
            "company_name": "Hausverwaltung Beispiel",
            "reply_snippet": "Klingt interessant, was genau machen Sie anders?",
            "last_message_text": "Klingt interessant, was genau machen Sie anders?",
            "last_message_from": "lead",
            "sequence_messages": {
                "name": "SEQUENZ B OHNE VERTRAG",
                "connect_note": "Hi {{first_name}}, kurzer Austausch zu KI in der Hausverwaltung?",
                "first_message": "Danke fürs Vernetzen Anna. Viele Verwaltungen testen KI, aber kaum etwas landet wirklich im Alltag.",
                "second_message": "Anna, wo hakt es bei euch eher: Daten, Prozesse oder Akzeptanz im Team?",
                "third_message": "Ich hake das Thema ab, falls KI gerade nicht relevant ist.",
            },
        },
        "Basis Prompt",
    )

    assert "SEQUENZ-STIL ALS SCHREIBVORBILD" in prompt
    assert "Viele Verwaltungen testen KI" in prompt
    assert "wo hakt es bei euch eher" in prompt
    assert "Beziehe dich konkret auf die letzte Nachricht" in prompt
    assert "Native deutsche Umlaute" in prompt


def test_sanitize_message_converts_common_ascii_umlaut_spellings():
    result = sanitize_message("Danke fuer den Hinweis. Das waere eine schoene Loesung fuer euer Team.")

    assert "für" in result
    assert "wäre" in result
    assert "schöne" in result
    assert "Lösung" in result
    assert "fuer" not in result
    assert "waere" not in result
    assert "schoene" not in result
    assert "Loesung" not in result
