import pytest

from sequence_render import render


LEAD = {
    "first_name": "Sven",
    "last_name": "Müller",
    "company_name": "Acme GmbH",
}


def test_double_curly():
    assert render("Hi {{first_name}}", LEAD) == "Hi Sven"


def test_single_curly():
    assert render("Hi {first_name}", LEAD) == "Hi Sven"


def test_bracket():
    assert render("Hi [first_name]", LEAD) == "Hi Sven"


def test_full_name_derived():
    assert render("{{full_name}}", LEAD) == "Sven Müller"


def test_missing_field_renders_empty():
    assert render("Hi {{first_name}}", {"last_name": "X"}) == "Hi "


def test_unknown_token_left_untouched():
    assert render("Hi {{recent_post}}", LEAD) == "Hi {{recent_post}}"


def test_legacy_aliases_VORNAME_NACHNAME():
    assert render("Hallo {{VORNAME}} {{NACHNAME}}", LEAD) == "Hallo Sven Müller"


def test_company_name():
    assert render("at {{company_name}}", LEAD) == "at Acme GmbH"


def test_salutation():
    assert render("Guten Tag {{salutation}} {{last_name}}", {**LEAD, "salutation": "Frau"}) == "Guten Tag Frau Müller"


def test_missing_salutation_fails_closed():
    try:
        render("Guten Tag {{salutation}} {{last_name}}", LEAD)
    except ValueError as exc:
        assert "Verified salutation" in str(exc)
    else:
        raise AssertionError("A salutation template must not render without verified evidence")
