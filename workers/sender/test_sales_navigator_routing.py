#!/usr/bin/env python3
"""Tests for Sales Navigator sender routing helpers."""

import sys
import asyncio
import inspect
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent))

import sender as sender_module
from sender import (
    INVITE_RETRY_STATUSES,
    CONNECT_ONLY_CONSECUTIVE_FAILURE_LIMIT,
    DIRECT_MESSAGE_COMPOSER_SELECTOR,
    DIRECT_MESSAGE_SCOPED_SEND_ROOT_SELECTORS,
    DIRECT_MESSAGE_SEND_BUTTON_SELECTOR,
    MESSAGE_ONLY_PROCESSING_STATUSES,
    _pick_send_button_candidate,
    classify_connect_only_surface,
    classify_connect_only_probe_surface,
    connect_only_sent_today_count,
    direct_thread_text_matches_lead,
    fetch_invite_queue,
    fetch_message_only_leads,
    build_sales_navigator_body,
    build_sales_navigator_subject,
    clear_message_only_retry_profile_data,
    is_network_outage_error,
    linkedin_absolute_url,
    _is_invite_candidate,
    _is_message_only_candidate,
    mark_connect_only_limit_reached,
    mark_invite_processing,
    mark_message_only_processing,
    normalize_typed_text,
    normalize_linkedin_profile_url,
    linkedin_profile_unavailable_reason,
    persist_invite_sent,
    post_send_bubble_near_match,
    promote_connect_only_to_connected,
    resolve_followup_batch_limit,
    send_sales_navigator_message,
    sender_name_is_own_account,
    strip_sales_navigator_signature,
    typed_text_matches,
    _message_only_priority,
    _connect_or_pending_label_matches,
    update_invite_failure_streak,
    insert_composer_text,
    verify_latest_outbound_message,
)


class FakeResponse:
    def __init__(self, data=None, count=None):
        self.data = data or []
        self.count = count

    def execute(self):
        return self


class FakeQuery:
    def __init__(self, client, table_name):
        self.client = client
        self.table_name = table_name
        self.filters = []
        self.payload = None

    def update(self, payload):
        self.payload = payload
        return self

    def eq(self, key, value):
        self.filters.append(("eq", key, value))
        return self

    def is_(self, key, value):
        self.filters.append(("is", key, value))
        return self

    def in_(self, key, values):
        self.filters.append(("in", key, list(values)))
        return self

    def gte(self, key, value):
        self.filters.append(("gte", key, value))
        return self

    def order(self, key, desc=False):
        self.filters.append(("order", key, desc))
        return self

    def limit(self, value):
        self.filters.append(("limit", value))
        return self

    def contains(self, key, value):
        self.filters.append(("contains", key, value))
        return self

    def execute(self):
        self.client.calls.append(
            {
                "table": self.table_name,
                "payload": self.payload,
                "filters": self.filters,
            }
        )
        lead = self.client.lead
        id_filter = next((f for f in self.filters if f[:2] == ("eq", "id")), None)
        status_filter = next((f for f in self.filters if f[:2] == ("in", "status")), None)
        sent_at_filter = next((f for f in self.filters if f[:2] == ("is", "sent_at")), None)
        if not id_filter or id_filter[2] != lead["id"]:
            return FakeResponse([])
        if status_filter and lead["status"] not in status_filter[2]:
            return FakeResponse([])
        if sent_at_filter and sent_at_filter[2] == "null" and lead.get("sent_at") is not None:
            return FakeResponse([])
        lead.update(self.payload or {})
        return FakeResponse([dict(lead)])


class FakeClient:
    def __init__(self, lead):
        self.lead = dict(lead)
        self.calls = []

    def table(self, table_name):
        return FakeQuery(self, table_name)


class FakeErrorResponse:
    def __init__(self, error):
        self.data = []
        self.error = error

    def execute(self):
        return self


class FakeInvitePersistQuery:
    def __init__(self, client, table_name):
        self.client = client
        self.table_name = table_name
        self.filters = []
        self.payload = None
        self.selected = None

    def update(self, payload):
        self.payload = payload
        return self

    def select(self, fields):
        self.selected = fields
        return self

    def eq(self, key, value):
        self.filters.append(("eq", key, value))
        return self

    def limit(self, value):
        self.filters.append(("limit", value))
        return self

    def execute(self):
        self.client.calls.append(
            {
                "table": self.table_name,
                "payload": self.payload,
                "selected": self.selected,
                "filters": list(self.filters),
            }
        )
        if self.client.error:
            return FakeErrorResponse(self.client.error)
        id_filter = next((f for f in self.filters if f[:2] == ("eq", "id")), None)
        if not id_filter or id_filter[2] != self.client.lead["id"]:
            return FakeResponse([])
        if self.payload is not None:
            self.client.lead.update(self.payload)
            if self.client.return_rows:
                return FakeResponse([dict(self.client.lead)])
            return FakeResponse([])
        return FakeResponse([dict(self.client.lead)])


class FakeInvitePersistClient:
    def __init__(self, lead, return_rows=True, error=None):
        self.lead = dict(lead)
        self.return_rows = return_rows
        self.error = error
        self.calls = []

    def table(self, table_name):
        return FakeInvitePersistQuery(self, table_name)


class FakeCountQuery:
    def __init__(self, client):
        self.client = client
        self.filters = []
        self.not_ = self

    def select(self, *_args, **_kwargs):
        return self

    def eq(self, key, value):
        self.filters.append(("eq", key, value))
        return self

    def gte(self, key, value):
        self.filters.append(("gte", key, value))
        return self

    def order(self, key, desc=False):
        self.filters.append(("order", key, desc))
        return self

    def limit(self, value):
        self.filters.append(("limit", value))
        return self

    def is_(self, key, value):
        self.filters.append(("not_is", key, value))
        return self

    def execute(self):
        self.client.calls.append(self.filters)
        return FakeResponse(count=self.client.count)


class FakeCountClient:
    def __init__(self, count=0):
        self.count = count
        self.calls = []

    def table(self, _table_name):
        return FakeCountQuery(self)


class FakeInviteQueueQuery:
    def __init__(self, client):
        self.client = client
        self.filters = []
        self.selected = None

    def select(self, fields):
        self.selected = fields
        return self

    def eq(self, key, value):
        self.filters.append(("eq", key, value))
        return self

    def in_(self, key, values):
        self.filters.append(("in", key, list(values)))
        return self

    def is_(self, key, value):
        self.filters.append(("is", key, value))
        return self

    def limit(self, value):
        self.filters.append(("limit", value))
        return self

    def execute(self):
        self.client.calls.append({"selected": self.selected, "filters": list(self.filters)})
        return FakeResponse(self.client.rows)


class FakeInviteQueueClient:
    def __init__(self, rows):
        self.rows = list(rows)
        self.calls = []

    def table(self, _table_name):
        return FakeInviteQueueQuery(self)


class FakeMessageOnlyQuery:
    def __init__(self, client):
        self.client = client
        self.filters = []
        self.selected = None

    def select(self, fields):
        self.selected = fields
        return self

    def eq(self, key, value):
        self.filters.append(("eq", key, value))
        return self

    def is_(self, key, value):
        self.filters.append(("is", key, value))
        return self

    def order(self, key, desc=False):
        self.filters.append(("order", key, desc))
        return self

    def limit(self, value):
        self.filters.append(("limit", value))
        return self

    def or_(self, value):
        self.filters.append(("or", value))
        return self

    def execute(self):
        self.client.calls.append(
            {
                "selected": self.selected,
                "filters": list(self.filters),
            }
        )
        return FakeResponse(self.client.rows)


class FakeMessageOnlyClient:
    def __init__(self, rows):
        self.rows = list(rows)
        self.calls = []

    def table(self, _table_name):
        return FakeMessageOnlyQuery(self)


class FakeKeyboard:
    def __init__(self, insert_error=None):
        self.typed = []
        self.inserted = []
        self.insert_error = insert_error

    async def type(self, text, delay=None):
        self.typed.append((text, delay))

    async def insert_text(self, text):
        if self.insert_error:
            raise self.insert_error
        self.inserted.append(text)


class FakePage:
    def __init__(self, insert_error=None):
        self.keyboard = FakeKeyboard(insert_error=insert_error)
        self.screenshots = []

    async def wait_for_timeout(self, timeout):
        await asyncio.sleep(min(float(timeout) / 1000, 0.001))

    async def screenshot(self, path, full_page=False):
        self.screenshots.append((path, full_page))


class FakeEditor:
    def __init__(self, fill_error=None):
        self.fill_error = fill_error
        self.filled = []
        self.clicked = False

    async def fill(self, text, timeout=None):
        if self.fill_error:
            raise self.fill_error
        self.filled.append((text, timeout))

    async def click(self):
        self.clicked = True


class AsyncBubble:
    def __init__(self, bubble):
        self.bubble = bubble

    async def __call__(self, _page):
        return self.bubble


class SalesNavigatorRoutingTest(unittest.TestCase):
    def test_normalize_linkedin_profile_url_removes_query_and_trailing_slash(self):
        result = normalize_linkedin_profile_url(
            "http://www.linkedin.com/in/marcel-ohlendorf-42335a197/?miniProfileUrn=abc"
        )

        self.assertEqual(result, "https://www.linkedin.com/in/marcel-ohlendorf-42335a197")

    def test_linkedin_profile_unavailable_detector_covers_german_404(self):
        class BodyLocator:
            async def inner_text(self, timeout=None):
                return "Diese Seite existiert nicht. Überprüfen Sie die URL."

        class Page:
            url = "https://www.linkedin.com/in/missing"

            def locator(self, selector):
                if selector != "body":
                    raise AssertionError(selector)
                return BodyLocator()

        result = asyncio.run(linkedin_profile_unavailable_reason(Page()))

        self.assertEqual(result, "linkedin_profile_not_found")

    def test_message_only_flow_refuses_page_level_profile_fallback(self):
        source = inspect.getsource(sender_module.process_message_only_one)

        self.assertIn("refusing to fall back to page-level selectors", source)
        self.assertIn("first_safe_message_target", source)
        self.assertNotIn("profile_container = page\n", source)

    def test_message_only_direct_thread_mismatch_retries_once(self):
        source = inspect.getsource(sender_module.process_message_only_one)

        self.assertIn("is_direct_thread_mismatch_error(send_error)", source)
        self.assertIn("First-message direct surface opened a stale or mismatched thread", source)
        self.assertIn("open_followup_message_surface(page)", source)

    def test_normalize_typed_text_matches_linkedin_collapsed_paragraph_spacing(self):
        expected = "Hi Sabrina,\n\nfreut mich, dass wir uns vernetzen.\n\nViele Gruesse,\nKatharina"
        actual = "Hi Sabrina, freut mich, dass wir uns vernetzen. Viele Gruesse, Katharina"

        self.assertEqual(normalize_typed_text(actual), normalize_typed_text(expected))

    def test_insert_composer_text_uses_insert_text_without_keyboard_enter(self):
        async def run():
            page = FakePage()
            editor = FakeEditor()
            method = await insert_composer_text(page, editor, "Hi Daniel,\n\nvolle Nachricht")
            return page, editor, method

        page, editor, method = asyncio.run(run())

        self.assertEqual(method, "insert_text")
        self.assertTrue(editor.clicked)
        self.assertEqual(editor.filled, [])
        self.assertEqual(page.keyboard.typed, [])
        self.assertEqual(page.keyboard.inserted, ["Hi Daniel,\n\nvolle Nachricht"])

    def test_insert_composer_text_fallback_uses_fill_not_keyboard_type(self):
        async def run():
            page = FakePage(insert_error=RuntimeError("insert unavailable"))
            editor = FakeEditor()
            method = await insert_composer_text(page, editor, "Hi Daniel,\n\nvolle Nachricht")
            return page, editor, method

        page, editor, method = asyncio.run(run())

        self.assertEqual(method, "fill")
        self.assertTrue(editor.clicked)
        self.assertEqual(editor.filled, [("Hi Daniel,\n\nvolle Nachricht", 10_000)])
        self.assertEqual(page.keyboard.inserted, [])
        self.assertEqual(page.keyboard.typed, [])

    def test_direct_thread_text_matches_hyphenated_lead_name(self):
        lead = {
            "first_name": "Iasonas",
            "last_name": "Kouveliotis Lysikatos",
        }

        self.assertTrue(
            direct_thread_text_matches_lead(
                "Iasonas Kouveliotis-Lysikatos",
                lead,
            )
        )
        self.assertFalse(direct_thread_text_matches_lead("Sabrina Lem", lead))

    def test_direct_thread_text_matches_accented_linkedin_identity(self):
        lead = {
            "first_name": "Elise",
            "last_name": "Lebosse",
        }

        self.assertTrue(direct_thread_text_matches_lead("Elise Lebossé", lead))

    def test_resolve_followup_batch_limit_respects_env_and_daily_remainder(self):
        from unittest.mock import patch

        with patch.dict("os.environ", {"FOLLOWUP_BATCH_LIMIT": "250"}):
            self.assertEqual(resolve_followup_batch_limit(17), 17)
            self.assertEqual(resolve_followup_batch_limit(300), 250)

    def test_sender_name_is_own_account_for_observed_linkedin_label(self):
        self.assertTrue(sender_name_is_own_account("Katharina Hoffmann"))
        self.assertFalse(sender_name_is_own_account("Sabrina Lem"))

    def test_direct_editor_identity_accepts_generic_new_message_header_with_recipient_preview(self):
        async def fake_identity(_editor):
            return {
                "headerTexts": ["Neue Nachricht"],
                "links": [],
                "rootPreview": "Neue Nachricht Liva Kallite 1. Grades Senior Product Designer",
            }

        async def fail_extract(_page):
            raise AssertionError("recipient preview should prove identity before bubble fallback")

        async def run():
            original_identity = sender_module.read_direct_message_editor_identity
            original_bubble = sender_module.extract_last_bubble
            sender_module.read_direct_message_editor_identity = fake_identity
            sender_module.extract_last_bubble = fail_extract
            try:
                await sender_module.assert_direct_message_editor_matches_lead(
                    FakePage(),
                    object(),
                    {"id": "lead-1", "first_name": "Liva", "last_name": "Kallite"},
                )
            finally:
                sender_module.read_direct_message_editor_identity = original_identity
                sender_module.extract_last_bubble = original_bubble

        asyncio.run(run())

    def test_network_outage_detector_matches_browser_and_dns_failures(self):
        self.assertTrue(is_network_outage_error("Page.goto: net::ERR_INTERNET_DISCONNECTED"))
        self.assertTrue(is_network_outage_error("[Errno 8] nodename nor servname provided, or not known"))
        self.assertFalse(is_network_outage_error("Direct message composer verification failed after typing"))

    def test_post_send_bubble_near_match_accepts_own_visible_truncation(self):
        expected = (
            "Hi Veronika,\n\nletzte kurze Nachricht.\n\n"
            "Drei Dinge stehen dir bei deinem Arbeitgeber zu:\n\n"
            "-> Arbeitgeberzuschuss zur Altersvorsorge (mindestens 15%)\n"
            "-> Steuerliche Foerderung (Beitrag aus dem Brutto)\n"
            "-> Sozialversicherungsersparnis\n\n"
            "Dazu kommt ab 2027 das neue Altersvorsorgedepot.\n\n"
            "eine komplett neue Moeglichkeit, steuerlich gefoerdert in ETFs zu sparen. "
            "Degura wird das ab Tag eins anbieten.\n\n"
            "Wenn du magst, schauen wir uns das kurz zusammen an, "
            "ich freue mich auf den Austausch.\n\n"
            "Viele Gruesse\nKatharina"
        )
        actual = (
            expected
            .replace("Sozialversicherungsersparnis", "Sozialversicherungser sparnis")
            .replace("Dazu", "Da zu")
            .replace("Gruesse", "Grues se")
            .replace("Katharina", "Katha rina")
        )

        matched, details = post_send_bubble_near_match(actual, expected)

        self.assertTrue(matched)
        self.assertTrue(details["prefixOk"])

    def test_post_send_bubble_near_match_accepts_linkedin_collapsed_block_breaks(self):
        expected = (
            "Hi Quentin,\n\nletzte kurze Nachricht.\n\n"
            "Drei Dinge stehen dir bei deinem Arbeitgeber zu:\n\n"
            "-> Arbeitgeberzuschuss zur Altersvorsorge (mindestens 15%)\n"
            "-> Steuerliche Foerderung (Beitrag aus dem Brutto)\n"
            "-> Sozialversicherungsersparnis\n\n"
            "Dazu kommt ab 2027 das neue Altersvorsorgedepot.\n\n"
            "eine komplett neue Moeglichkeit, steuerlich gefoerdert in ETFs zu sparen. "
            "Degura wird das ab Tag eins anbieten.\n\n"
            "Wenn du magst, schauen wir uns das kurz zusammen an, "
            "ich freue mich auf den Austausch.\n\n"
            "Viele Gruesse\nKatharina"
        )
        actual = (
            "Hi Quentin,letzte kurze Nachricht."
            "Drei Dinge stehen dir bei deinem Arbeitgeber zu:"
            "-> Arbeitgeberzuschuss zur Altersvorsorge (mindestens 15%)"
            "-> Steuerliche Foerderung (Beitrag aus dem Brutto)"
            "-> Sozialversicherungser sparnis"
            "Da zu kommt ab 2027 das neue Altersvorsorgedepot."
            "eine komplett neue Moeglichkeit, steuerlich gefoerdert in ETFs zu sparen. "
            "Degura wird das ab Tag eins anbieten."
            "Wenn du magst, schauen wir uns das kurz zusammen an, "
            "ich freue mich auf den Austausch."
            "Viele Grues se"
            "Katha rina"
        )

        matched, details = post_send_bubble_near_match(actual, expected)

        self.assertTrue(matched)
        self.assertTrue(details["prefixOk"])

    def test_sales_navigator_body_only_composer_does_not_require_subject(self):
        from unittest.mock import AsyncMock, patch

        class Locator:
            def __init__(self, count, visible=True):
                self._count = count
                self.visible = visible
                self.first = self

            async def count(self):
                return self._count

            def nth(self, _index):
                return self

            async def wait_for(self, **_kwargs):
                if not self.visible:
                    raise TimeoutError("hidden")
                return None

        class Page:
            def __init__(self):
                self.body = Locator(1)
                self.subject = Locator(0)

            def locator(self, selector):
                if "subject" in selector.lower() or "betreff" in selector.lower():
                    return self.subject
                return self.body

            async def wait_for_timeout(self, _timeout):
                return None

        page = Page()
        filled = []

        async def fake_fill(_page, selector_name, locator, value):
            filled.append((selector_name, locator, value))

        async def run():
            with patch.object(sender_module, "fill_text_field", AsyncMock(side_effect=fake_fill)), \
                patch.object(sender_module, "click_editor_scoped_send_button", AsyncMock(return_value=True)), \
                patch.object(sender_module, "random_pause", AsyncMock()):
                await send_sales_navigator_message(page, "Subject text", "Body text")

        asyncio.run(run())

        self.assertEqual(len(filled), 1)
        self.assertEqual(filled[0][2], "Body text")
        self.assertIs(filled[0][1], page.body)

    def test_sales_navigator_body_selection_skips_hidden_textarea(self):
        from unittest.mock import AsyncMock, patch

        class Locator:
            def __init__(self, count, visible=True):
                self._count = count
                self.visible = visible
                self.first = self

            async def count(self):
                return self._count

            def nth(self, _index):
                return self

            async def wait_for(self, **_kwargs):
                if not self.visible:
                    raise TimeoutError("hidden")
                return None

            async def evaluate(self, _script):
                return self.visible

        class Page:
            def __init__(self):
                self.hidden_textarea = Locator(1, visible=False)
                self.visible_editor = Locator(1, visible=True)
                self.subject = Locator(0)

            def locator(self, selector):
                lowered = selector.lower()
                if "subject" in lowered or "betreff" in lowered:
                    return self.subject
                if "textarea" in lowered:
                    return self.hidden_textarea
                return self.visible_editor

            async def wait_for_timeout(self, _timeout):
                return None

        page = Page()
        filled = []

        async def fake_fill(_page, selector_name, locator, value):
            filled.append((selector_name, locator, value))

        async def run():
            with patch.object(sender_module, "fill_text_field", AsyncMock(side_effect=fake_fill)), \
                patch.object(sender_module, "click_editor_scoped_send_button", AsyncMock(return_value=True)), \
                patch.object(sender_module, "random_pause", AsyncMock()):
                await send_sales_navigator_message(page, "Subject text", "Body text")

        asyncio.run(run())

        self.assertEqual(len(filled), 1)
        self.assertIs(filled[0][1], page.visible_editor)

    def test_sales_navigator_does_not_click_global_send_fallback_when_scoped_send_missing(self):
        from unittest.mock import AsyncMock, patch

        class Locator:
            def __init__(self, count=1, visible=True):
                self._count = count
                self.visible = visible
                self.first = self
                self.clicked = False

            async def count(self):
                return self._count

            def nth(self, _index):
                return self

            async def wait_for(self, **_kwargs):
                if not self.visible:
                    raise TimeoutError("hidden")
                return None

            async def is_enabled(self):
                return True

            async def click(self):
                self.clicked = True

        class Page:
            def __init__(self):
                self.subject = Locator(0)
                self.body = Locator(1)
                self.global_send = Locator(1)

            def locator(self, selector):
                lowered = selector.lower()
                if "subject" in lowered or "betreff" in lowered:
                    return self.subject
                if "button.msg-form__send-button" in lowered:
                    return self.global_send
                return self.body

            async def wait_for_timeout(self, _timeout):
                return None

        page = Page()

        async def run():
            with patch.object(sender_module, "fill_text_field", AsyncMock()), \
                patch.object(sender_module, "click_editor_scoped_send_button", AsyncMock(return_value=False)), \
                patch.object(sender_module, "random_pause", AsyncMock()):
                await send_sales_navigator_message(page, "Subject text", "Body text")

        with self.assertRaises(RuntimeError):
            asyncio.run(run())
        self.assertFalse(page.global_send.clicked)

    def test_sales_navigator_overlay_probe_supports_icon_only_send_button(self):
        source = inspect.getsource(sender_module.click_sales_navigator_overlay_send_button)

        self.assertIn("iconOnlySend", source)
        self.assertIn("hasProminentBackground", source)
        self.assertIn("classText", source)
        self.assertIn("bodyFields", source)
        self.assertIn("rootIndex", source)
        self.assertIn('querySelectorAll("button, [role=\\"button\\"]")', source)

    def test_sales_navigator_visual_send_fallback_is_composer_bounded(self):
        source = inspect.getsource(sender_module.click_sales_navigator_visual_send_button)

        self.assertIn("bodySendZone", source)
        self.assertIn("paper-plane", source)
        self.assertIn("page.mouse.click", source)
        self.assertIn("fallbackComposerRoot", source)
        self.assertIn('div[contenteditable="true"]', source)
        self.assertIn("usingViewportRoot", source)
        self.assertIn("viewportHeight - 70", source)
        self.assertIn("rootRect", source)

    def test_followup_message_target_skips_feed_activity_controls(self):
        source = inspect.getsource(sender_module.message_target_is_feed_surface)

        self.assertIn("/feed/update/", source)
        self.assertIn("urn:li:activity", source)
        self.assertIn("profile-creator-shared-feed-update", source)
        self.assertIn("data-urn", source)

    def test_close_existing_chat_overlays_scans_role_button_controls(self):
        source = inspect.getsource(sender_module.close_existing_chat_overlays)

        self.assertIn('querySelectorAll("button, [role=\\"button\\"]")', source)

    def test_send_message_has_no_direct_keyboard_send_fallback(self):
        source = inspect.getsource(sender_module.send_message)

        self.assertNotIn("keyboard.press(\"Enter\")", source)
        self.assertNotIn("Meta+Enter", source)
        self.assertNotIn("Control+Enter", source)
        self.assertNotIn("Enter fallback", source)

    def test_verify_latest_outbound_message_accepts_full_bubble(self):
        async def run():
            page = FakePage()
            original = sender_module.extract_last_bubble
            sender_module.extract_last_bubble = AsyncBubble(
                {"sender": "Sie", "text": "Hi Daniel,\n\nvolle Nachricht mit Inhalt", "is_outbound": True}
            )
            try:
                return await verify_latest_outbound_message(
                    page,
                    "Hi Daniel,\n\nvolle Nachricht mit Inhalt",
                    timeout_ms=10,
                )
            finally:
                sender_module.extract_last_bubble = original

        details = asyncio.run(run())

        self.assertEqual(details["missingWords"], [])

    def test_verify_latest_outbound_message_rejects_chopped_greeting(self):
        async def run():
            page = FakePage()
            original = sender_module.extract_last_bubble
            sender_module.extract_last_bubble = AsyncBubble(
                {"sender": "Sie", "text": "Hi Daniel,", "is_outbound": True}
            )
            try:
                await verify_latest_outbound_message(
                    page,
                    "Hi Daniel,\n\nvolle Nachricht mit Inhalt",
                    timeout_ms=5,
                )
            finally:
                sender_module.extract_last_bubble = original

        with self.assertRaises(RuntimeError):
            asyncio.run(run())

    def test_direct_message_wait_selector_covers_current_linkedin_composer(self):
        self.assertIn("Write a message", DIRECT_MESSAGE_COMPOSER_SELECTOR)
        self.assertIn("Nachricht verfassen", DIRECT_MESSAGE_COMPOSER_SELECTOR)
        self.assertIn("data-placeholder*='Nachricht'", DIRECT_MESSAGE_COMPOSER_SELECTOR)
        self.assertIn("msg-form-ember", DIRECT_MESSAGE_COMPOSER_SELECTOR)
        self.assertIn("form.msg-form", DIRECT_MESSAGE_COMPOSER_SELECTOR)
        self.assertIn("role='textbox'", DIRECT_MESSAGE_COMPOSER_SELECTOR)
        self.assertNotIn(
            "div[role='textbox'][contenteditable='true']:not([id^='g-recaptcha'])",
            DIRECT_MESSAGE_COMPOSER_SELECTOR,
        )

    def test_direct_message_editor_skips_feed_comment_surfaces(self):
        source = inspect.getsource(sender_module.direct_message_editor_is_comment_surface)

        self.assertIn("comments-comment", source)
        self.assertIn("comment-box", source)
        self.assertIn("feed-shared", source)
        self.assertIn("hasMessageRoot", source)

    def test_direct_message_send_selector_covers_current_linkedin_button(self):
        self.assertIn("msg-form__send-button", DIRECT_MESSAGE_SEND_BUTTON_SELECTOR)
        self.assertIn("Nachricht senden", DIRECT_MESSAGE_SEND_BUTTON_SELECTOR)
        self.assertIn("type='submit'", DIRECT_MESSAGE_SEND_BUTTON_SELECTOR)

    def test_pick_send_button_candidate_prefers_editor_root_enabled_button(self):
        candidates = [
            {"domIndex": 1, "text": "Senden", "visible": True, "enabled": False, "withinEditorRoot": False},
            {"domIndex": 4, "text": "Senden", "visible": True, "enabled": True, "withinEditorRoot": True},
        ]

        result = _pick_send_button_candidate(candidates)

        self.assertEqual(result["domIndex"], 4)

    def test_pick_send_button_candidate_falls_back_to_last_visible_match(self):
        candidates = [
            {"domIndex": 2, "text": "Senden", "visible": True, "enabled": False, "withinEditorRoot": True},
            {"domIndex": 5, "text": "Senden", "visible": True, "enabled": False, "withinEditorRoot": True},
        ]

        result = _pick_send_button_candidate(candidates)

        self.assertEqual(result["domIndex"], 5)

    def test_scoped_send_roots_include_msg_form_ancestor(self):
        roots = " ".join(DIRECT_MESSAGE_SCOPED_SEND_ROOT_SELECTORS)

        self.assertIn("msg-form", roots)

    def test_linkedin_absolute_url_normalizes_relative_compose_href(self):
        result = linkedin_absolute_url("/messaging/compose/?recipient=abc")

        self.assertEqual(result, "https://www.linkedin.com/messaging/compose/?recipient=abc")

    def test_pick_send_button_candidate_prefers_msg_form_button_over_global_send(self):
        candidates = [
            {
                "domIndex": 1,
                "text": "Senden",
                "visible": True,
                "enabled": True,
                "withinEditorRoot": False,
                "className": "artdeco-button",
            },
            {
                "domIndex": 3,
                "text": "",
                "visible": True,
                "enabled": True,
                "withinEditorRoot": True,
                "className": "msg-form__send-button artdeco-button",
            },
        ]

        result = _pick_send_button_candidate(candidates)

        self.assertEqual(result["domIndex"], 3)

    def test_typed_text_matches_accepts_small_extraction_gap_when_words_match(self):
        expected = "Hi Sabrina, freut mich, dass wir uns vernetzen. Viele Gruesse, Katharina"
        actual = "Hi Sabrina, freut mich, dass wir uns vernetzen. Viele Gruesse Katharina"

        matched, details = typed_text_matches(actual, expected)

        self.assertTrue(matched, details)

    def test_typed_text_matches_rejects_missing_name(self):
        expected = "Hi Sabrina, freut mich, dass wir uns vernetzen. Viele Gruesse, Katharina"
        actual = "Hi, freut mich, dass wir uns vernetzen. Viele Gruesse, Katharina"

        matched, details = typed_text_matches(actual, expected)

        self.assertFalse(matched)
        self.assertIn("sabrina", details["missingWords"])

    def test_clear_message_only_retry_profile_data_preserves_unrelated_metadata(self):
        lead = {
            "profile_data": {
                "message_only_retry_attempts": 2,
                "message_only_last_error": "old composer error",
                "message_only_last_retry_at": "2026-05-06T22:23:39",
                "source": "live-test",
            }
        }

        cleaned = clear_message_only_retry_profile_data(lead)

        self.assertEqual(cleaned, {"source": "live-test"})

    def test_connect_or_pending_label_ignores_unrelated_recommendation_connect_button(self):
        self.assertFalse(_connect_or_pending_label_matches("Stefanie Vogt als Kontakt einladen", "Daniel Herm"))

    def test_connect_or_pending_label_accepts_profile_pending_state(self):
        self.assertTrue(_connect_or_pending_label_matches("Ausstehend", "Daniel Herm"))

    def test_connect_or_pending_label_accepts_profile_invite_action(self):
        self.assertTrue(_connect_or_pending_label_matches("Daniel Herm als Kontakt einladen", "Daniel Herm"))

    def test_build_sales_navigator_subject_uses_sales_navigator_subject_copy(self):
        subject = build_sales_navigator_subject(
            {
                "first_name": "Marcel",
                "last_name": "Ohlendorf",
                "company_name": "Degura",
            },
            "Hi Marcel,\n\nfreut mich, dass wir uns hier vernetzen.\n\nIch bin Katharina.",
        )

        self.assertEqual(subject, "Kurze Frage zu deiner bAV")

    def test_build_sales_navigator_subject_stays_stable_without_message(self):
        subject = build_sales_navigator_subject({"first_name": "Marcel", "company_name": "Degura"})

        self.assertEqual(subject, "Kurze Frage zu deiner bAV")

    def test_strip_sales_navigator_signature_preserves_manual_closing_with_name(self):
        body = (
            "Hi Marina,\n\n"
            "freut mich, dass wir uns hier vernetzen.\n\n"
            "Viele Grüße,\nKatharina"
        )

        self.assertEqual(strip_sales_navigator_signature(body), body)

    def test_strip_sales_navigator_signature_preserves_single_line_closing_with_name(self):
        body = (
            "Hi Marina,\n\n"
            "freut mich, dass wir uns hier vernetzen.\n\n"
            "Viele Grüße, Katharina"
        )

        self.assertEqual(strip_sales_navigator_signature(body), body)

    def test_strip_sales_navigator_signature_keeps_non_signature_body(self):
        body = "Hi Marina,\n\nfreut mich, dass wir uns hier vernetzen."

        self.assertEqual(strip_sales_navigator_signature(body), body)

    def test_build_sales_navigator_body_preserves_signature(self):
        message = (
            "Hi Marina,\n\n"
            "freut mich, dass wir uns hier vernetzen.\n\n"
            "Viele Grüße,\nKatharina"
        )

        self.assertEqual(build_sales_navigator_body(message), message)

    def test_mark_message_only_processing_locks_connected_without_legacy_timestamp(self):
        lead = {"id": "lead-1", "status": "CONNECTED", "sent_at": None}
        client = FakeClient(lead)

        result = mark_message_only_processing(client, lead)

        self.assertTrue(result)
        self.assertEqual(client.lead["status"], "PROCESSING")
        self.assertEqual(client.calls[0]["filters"][1], ("in", "status", list(MESSAGE_ONLY_PROCESSING_STATUSES)))

    def test_mark_message_only_processing_skips_processing_without_invite_timestamp(self):
        lead = {"id": "lead-1", "status": "PROCESSING", "sent_at": None}
        client = FakeClient(lead)

        result = mark_message_only_processing(client, lead)

        self.assertFalse(result)
        self.assertEqual(client.lead["status"], "PROCESSING")
        self.assertEqual(client.calls, [])

    def test_mark_message_only_processing_allows_targeted_probe_without_invite_timestamp(self):
        lead = {
            "id": "lead-1",
            "status": "FAILED",
            "sent_at": None,
            "outreach_mode": "connect_only",
            "sequence_id": 4,
        }
        client = FakeClient(lead)

        result = mark_message_only_processing(client, lead, allow_missing_invite_evidence=True)

        self.assertTrue(result)
        self.assertEqual(client.lead["status"], "PROCESSING")
        self.assertEqual(client.calls[0]["filters"][1], ("is", "sent_at", "null"))

    def test_mark_message_only_processing_locks_invite_sent_lead_even_if_status_is_new(self):
        lead = {
            "id": "lead-1",
            "status": "NEW",
            "sent_at": None,
            "connection_sent_at": "2026-04-26T00:00:00Z",
        }
        client = FakeClient(lead)

        result = mark_message_only_processing(client, lead)

        self.assertTrue(result)
        self.assertEqual(client.lead["status"], "PROCESSING")
        self.assertEqual(client.calls[0]["filters"][1], ("is", "sent_at", "null"))

    def test_mark_message_only_processing_skips_sent_lead(self):
        lead = {"id": "lead-1", "status": "SENT"}
        client = FakeClient(lead)

        result = mark_message_only_processing(client, lead)

        self.assertFalse(result)
        self.assertEqual(client.lead["status"], "SENT")

    def test_mark_message_only_pending_restores_invite_sent_state(self):
        from sender import mark_message_only_pending

        lead = {
            "id": "lead-1",
            "status": "PROCESSING",
            "connection_sent_at": "2026-05-06T10:00:00Z",
            "connection_accepted_at": "2026-05-06T11:00:00Z",
        }
        client = FakeClient(lead)

        mark_message_only_pending(client, lead)

        self.assertEqual(client.lead["status"], "CONNECT_ONLY_SENT")
        self.assertIsNone(client.lead["error_message"])
        self.assertIsNone(client.lead["connection_accepted_at"])

    def test_fetch_invite_queue_includes_failed_invite_leads_for_retry(self):
        client = FakeInviteQueueClient(
            [
                {"id": "lead-new", "status": "NEW", "outreach_mode": "connect_only", "profile_data": {}},
                {"id": "lead-failed", "status": "FAILED", "outreach_mode": "connect_only", "profile_data": {}},
            ]
        )

        rows = fetch_invite_queue(client, 10)

        self.assertEqual([row["id"] for row in rows], ["lead-new", "lead-failed"])
        self.assertIn(("in", "status", INVITE_RETRY_STATUSES), client.calls[0]["filters"])

    def test_fetch_invite_queue_excludes_attempted_leads_for_current_run(self):
        client = FakeInviteQueueClient(
            [
                {"id": "lead-failed", "status": "FAILED", "outreach_mode": "connect_only", "profile_data": {}},
                {"id": "lead-replacement", "status": "NEW", "outreach_mode": "connect_only", "profile_data": {}},
            ]
        )

        rows = fetch_invite_queue(client, 1, exclude_ids={"lead-failed"})

        self.assertEqual([row["id"] for row in rows], ["lead-replacement"])

    def test_mark_invite_processing_claims_failed_invite_lead_for_retry(self):
        lead = {"id": "lead-1", "status": "FAILED"}
        client = FakeClient(lead)

        result = mark_invite_processing(client, "lead-1")

        self.assertTrue(result)
        self.assertEqual(client.lead["status"], "PROCESSING")
        self.assertEqual(client.calls[0]["filters"][1], ("in", "status", INVITE_RETRY_STATUSES))

    def test_invite_candidate_accepts_failed_connect_only_without_connection_sent(self):
        self.assertTrue(
            _is_invite_candidate(
                {
                    "status": "FAILED",
                    "outreach_mode": "connect_only",
                    "connection_sent_at": None,
                    "sent_at": None,
                }
            )
        )

    def test_invite_candidate_rejects_failed_lead_after_connection_was_sent(self):
        self.assertFalse(
            _is_invite_candidate(
                {
                    "status": "FAILED",
                    "outreach_mode": "connect_only",
                    "connection_sent_at": "2026-05-06T10:00:00Z",
                    "sent_at": None,
                }
            )
        )

    def test_connect_only_sent_today_count_uses_connection_sent_at_for_connect_only_rows(self):
        client = FakeCountClient(count=7)

        result = connect_only_sent_today_count(client)

        self.assertEqual(result, 7)
        self.assertTrue(any(item[0] == "eq" and item[1] == "outreach_mode" and item[2] == "connect_only" for item in client.calls[0]))
        self.assertTrue(any(item[0] == "not_is" and item[1] == "connection_sent_at" and item[2] == "null" for item in client.calls[0]))

    def test_mark_connect_only_limit_reached_persists_pause_metadata(self):
        lead = {"id": "lead-1", "profile_data": {"meta": {"existing": True}}}
        client = FakeClient(lead)

        mark_connect_only_limit_reached(client, lead, "LinkedIn weekly invite limit reached")

        self.assertEqual(client.lead["status"], "FAILED")
        self.assertEqual(client.lead["error_message"], "LinkedIn weekly invite limit reached")
        self.assertTrue(client.lead["profile_data"]["meta"]["connect_only_limit_reached"])
        self.assertEqual(
            client.lead["profile_data"]["meta"]["connect_only_limit_reason"],
            "LinkedIn weekly invite limit reached",
        )
        self.assertIn("connect_only_limit_at", client.lead["profile_data"]["meta"])
        self.assertTrue(client.lead["profile_data"]["meta"]["existing"])

    def test_invite_failure_streak_stops_after_three_consecutive_send_failures(self):
        streak, stop = update_invite_failure_streak("send_failed", 0)
        self.assertEqual(streak, 1)
        self.assertFalse(stop)

        streak, stop = update_invite_failure_streak("send_failed", streak)
        self.assertEqual(streak, 2)
        self.assertFalse(stop)

        streak, stop = update_invite_failure_streak("send_failed", streak)
        self.assertEqual(streak, CONNECT_ONLY_CONSECUTIVE_FAILURE_LIMIT)
        self.assertTrue(stop)

    def test_invite_failure_streak_ignores_profile_and_selector_failures(self):
        streak, stop = update_invite_failure_streak("profile_failed", 2)
        self.assertEqual(streak, 2)
        self.assertFalse(stop)

        streak, stop = update_invite_failure_streak("no_invite_path", streak)
        self.assertEqual(streak, 2)
        self.assertFalse(stop)

    def test_invite_failure_streak_resets_after_successful_invite_state(self):
        streak, stop = update_invite_failure_streak("send_failed", 2)
        self.assertTrue(stop)

        streak, stop = update_invite_failure_streak("sent", streak)
        self.assertEqual(streak, 0)
        self.assertFalse(stop)

    def test_persist_invite_sent_moves_lead_to_connect_only_sent(self):
        lead = {"id": "lead-1", "status": "PROCESSING", "outreach_mode": "connect_only"}
        client = FakeInvitePersistClient(lead)

        persist_invite_sent(client, "lead-1", "connect_only")

        self.assertEqual(client.lead["status"], "CONNECT_ONLY_SENT")
        self.assertTrue(client.lead["connection_sent_at"])

    def test_persist_invite_sent_verifies_update_when_supabase_returns_no_rows(self):
        lead = {"id": "lead-1", "status": "PROCESSING", "outreach_mode": "connect_only"}
        client = FakeInvitePersistClient(lead, return_rows=False)

        persist_invite_sent(client, "lead-1", "connect_only")

        self.assertEqual(client.lead["status"], "CONNECT_ONLY_SENT")
        self.assertEqual(client.calls[1]["selected"], "id, status, connection_sent_at, outreach_mode")

    def test_persist_invite_sent_raises_on_supabase_error(self):
        lead = {"id": "lead-1", "status": "PROCESSING", "outreach_mode": "connect_only"}
        client = FakeInvitePersistClient(lead, error="status enum rejected")

        with self.assertRaises(RuntimeError):
            persist_invite_sent(client, "lead-1", "connect_only")

    def test_classify_connect_only_surface_prefers_message_surface(self):
        self.assertEqual(
            classify_connect_only_surface(
                message_button_count=1,
                message_link_count=0,
                invite_link_count=0,
                connect_button_count=0,
                more_button_count=0,
            ),
            "already_connected",
        )

    def test_classify_connect_only_surface_keeps_invite_flow_when_message_surface_is_absent(self):
        self.assertEqual(
            classify_connect_only_surface(
                message_button_count=0,
                message_link_count=0,
                invite_link_count=1,
                connect_button_count=0,
                more_button_count=0,
            ),
            "invite_available",
        )

    def test_connect_only_surface_classifier_returns_surface_exhausted_when_no_actions_exist(self):
        self.assertEqual(
            classify_connect_only_surface(
                message_button_count=0,
                message_link_count=0,
                invite_link_count=0,
                connect_button_count=0,
                more_button_count=0,
            ),
            "surface_exhausted",
        )

    def test_classify_connect_only_probe_surface_ignores_ambiguous_generic_message_link(self):
        self.assertEqual(
            classify_connect_only_probe_surface(
                explicit_message_button_count=0,
                explicit_message_link_count=0,
                generic_message_link_count=1,
                invite_link_count=1,
                connect_button_count=0,
                more_button_count=0,
                has_visible_connect_or_pending_state=True,
            ),
            "invite_available",
        )

    def test_classify_connect_only_probe_surface_detects_pending_invite_from_more_menu(self):
        self.assertEqual(
            classify_connect_only_probe_surface(
                explicit_message_button_count=0,
                explicit_message_link_count=0,
                generic_message_link_count=1,
                invite_link_count=0,
                connect_button_count=0,
                more_button_count=1,
                has_visible_connect_or_pending_state=True,
                has_more_menu_pending_state=True,
            ),
            "pending_invite",
        )

    def test_classify_connect_only_probe_surface_treats_remove_contact_menu_as_connected(self):
        self.assertEqual(
            classify_connect_only_probe_surface(
                explicit_message_button_count=0,
                explicit_message_link_count=0,
                generic_message_link_count=1,
                invite_link_count=0,
                connect_button_count=0,
                more_button_count=1,
                has_visible_connect_or_pending_state=False,
                has_more_menu_connected_state=True,
            ),
            "already_connected",
        )

    def test_classify_connect_only_probe_surface_keeps_verified_more_menu_invite_before_generic_message(self):
        self.assertEqual(
            classify_connect_only_probe_surface(
                explicit_message_button_count=0,
                explicit_message_link_count=0,
                generic_message_link_count=1,
                invite_link_count=0,
                connect_button_count=0,
                more_button_count=1,
                has_visible_connect_or_pending_state=False,
                has_more_menu_invite_state=True,
            ),
            "invite_available",
        )

    def test_classify_connect_only_probe_surface_accepts_generic_message_link_without_invite_state(self):
        self.assertEqual(
            classify_connect_only_probe_surface(
                explicit_message_button_count=0,
                explicit_message_link_count=0,
                generic_message_link_count=1,
                invite_link_count=0,
                connect_button_count=0,
                more_button_count=0,
                has_visible_connect_or_pending_state=False,
            ),
            "already_connected",
        )

    def test_classify_connect_only_probe_surface_keeps_invite_link_before_generic_message(self):
        self.assertEqual(
            classify_connect_only_probe_surface(
                explicit_message_button_count=0,
                explicit_message_link_count=0,
                generic_message_link_count=1,
                invite_link_count=1,
                connect_button_count=0,
                more_button_count=0,
                has_visible_connect_or_pending_state=False,
            ),
            "invite_available",
        )

    def test_classify_connect_only_probe_surface_keeps_connect_button_before_generic_message(self):
        self.assertEqual(
            classify_connect_only_probe_surface(
                explicit_message_button_count=0,
                explicit_message_link_count=0,
                generic_message_link_count=1,
                invite_link_count=0,
                connect_button_count=1,
                more_button_count=0,
                has_visible_connect_or_pending_state=False,
            ),
            "invite_available",
        )

    def test_classify_connect_only_probe_surface_requires_more_menu_invite_verification_before_generic_message(self):
        self.assertEqual(
            classify_connect_only_probe_surface(
                explicit_message_button_count=0,
                explicit_message_link_count=0,
                generic_message_link_count=1,
                invite_link_count=0,
                connect_button_count=0,
                more_button_count=1,
                has_visible_connect_or_pending_state=False,
            ),
            "already_connected",
        )

    def test_promote_connect_only_to_connected_updates_lead_status(self):
        lead = {"id": "lead-1", "status": "NEW"}
        client = FakeClient(lead)

        result = promote_connect_only_to_connected(client, lead)

        self.assertEqual(result, "connected")
        self.assertEqual(client.lead["status"], "CONNECTED")
        self.assertTrue(client.lead["connection_accepted_at"])

    def test_message_only_candidate_accepts_invite_sent_timestamp(self):
        self.assertTrue(
            _is_message_only_candidate(
                {
                    "status": "NEW",
                    "connection_sent_at": "2026-04-26T00:00:00Z",
                    "sent_at": None,
                }
            )
        )

    def test_message_only_candidate_rejects_permanent_profile_failure(self):
        self.assertFalse(
            _is_message_only_candidate(
                {
                    "status": "FAILED",
                    "connection_sent_at": "2026-04-26T00:00:00Z",
                    "sent_at": None,
                    "error_message": "LinkedIn profile unavailable: linkedin_profile_not_found",
                }
            )
        )

    def test_message_only_candidate_keeps_transient_timeout_retryable(self):
        self.assertTrue(
            _is_message_only_candidate(
                {
                    "status": "FAILED",
                    "connection_sent_at": "2026-04-26T00:00:00Z",
                    "sent_at": None,
                    "error_message": "Page.wait_for_selector: Timeout 20000ms exceeded",
                }
            )
        )

    def test_message_only_candidate_rejects_unstarted_new_lead(self):
        self.assertFalse(
            _is_message_only_candidate(
                {
                    "status": "NEW",
                    "connection_sent_at": None,
                    "sent_at": None,
                }
            )
        )

    def test_message_only_candidate_accepts_connected_without_legacy_timestamp(self):
        self.assertTrue(
            _is_message_only_candidate(
                {
                    "status": "CONNECTED",
                    "connection_sent_at": None,
                    "connection_accepted_at": None,
                    "sent_at": None,
                }
            )
        )

    def test_message_only_priority_prefers_accepted_before_pending_invites(self):
        rows = [
            {"id": "pending", "status": "CONNECT_ONLY_SENT", "connection_sent_at": "2026-05-06T10:00:00Z"},
            {"id": "message-ready", "status": "MESSAGE_ONLY_READY", "connection_sent_at": None},
            {"id": "connected", "status": "CONNECTED", "connection_sent_at": None},
            {"id": "accepted", "status": "PROCESSING", "connection_accepted_at": "2026-05-06T11:00:00Z"},
        ]

        ordered = sorted(rows, key=_message_only_priority)

        self.assertEqual([row["id"] for row in ordered], ["message-ready", "connected", "accepted", "pending"])

    def test_fetch_message_only_leads_queries_only_post_invite_candidates(self):
        eligible_row = {
            "id": "lead-eligible",
            "status": "NEW",
            "sent_at": None,
            "connection_sent_at": "2026-04-26T00:00:00Z",
            "connection_accepted_at": None,
            "outreach_mode": "connect_only",
        }
        legacy_connected_row = {
            "id": "lead-legacy-connected",
            "status": "CONNECTED",
            "sent_at": None,
            "connection_sent_at": None,
            "connection_accepted_at": None,
            "outreach_mode": "connect_only",
        }
        stale_processing_row = {
            "id": "lead-stale-processing",
            "status": "PROCESSING",
            "sent_at": None,
            "connection_sent_at": None,
            "connection_accepted_at": None,
            "outreach_mode": "connect_only",
        }
        client = FakeMessageOnlyClient([stale_processing_row, legacy_connected_row, eligible_row])

        rows = fetch_message_only_leads(client, 25)

        self.assertEqual(rows, [legacy_connected_row, eligible_row])
        self.assertEqual(client.calls[0]["filters"][0], ("eq", "outreach_mode", "connect_only"))
        self.assertEqual(client.calls[0]["filters"][1], ("is", "sent_at", "null"))
        self.assertEqual(
            client.calls[0]["filters"][2],
            (
                "or",
                "connection_sent_at.not.is.null,"
                "connection_accepted_at.not.is.null,"
                "status.in.(CONNECTED,MESSAGE_ONLY_READY,MESSAGE_ONLY_APPROVED)",
            ),
        )


class FollowupSalesNavigatorRoutingTest(unittest.IsolatedAsyncioTestCase):
    """process_followup_one must detect Sales Navigator composers so the
    Subject field is filled; otherwise the InMail Send button stays disabled.
    """

    def _build_followup(self) -> dict:
        lead = {
            "id": "lead-1",
            "first_name": "Marina",
            "last_name": "Schulz",
            "company_name": "Acme",
            "linkedin_url": "https://www.linkedin.com/in/marina-schulz",
        }
        return {
            "id": "fu-1",
            "lead_id": "lead-1",
            "draft_text": (
                "Hi Marina,\n\nnur ein kurzer Followup zu meiner letzten Nachricht.\n\n"
                "Viele Grüße,\nKatharina"
            ),
            "followup_type": "NUDGE",
            "attempt": 2,
            "lead": lead,
        }

    def _build_mock_page(self):
        from unittest.mock import AsyncMock, MagicMock

        page = MagicMock()
        page.goto = AsyncMock()
        page.wait_for_timeout = AsyncMock()
        page.close = AsyncMock()
        page.screenshot = AsyncMock()
        return page

    def _patches(self, *, surface_result):
        """Patch `open_followup_message_surface` with `surface_result`.

        `surface_result` is an Exception, a `(target_page, surface_string)`
        tuple, or a list consumed as `side_effect`.
        """
        from contextlib import ExitStack
        from unittest.mock import AsyncMock, MagicMock, patch

        import sender as sender_mod

        stack = ExitStack()
        mocks = {}

        if isinstance(surface_result, list):
            mocks["open_followup_message_surface"] = stack.enter_context(
                patch.object(
                    sender_mod,
                    "open_followup_message_surface",
                    AsyncMock(side_effect=surface_result),
                )
            )
        elif isinstance(surface_result, Exception):
            mocks["open_followup_message_surface"] = stack.enter_context(
                patch.object(
                    sender_mod,
                    "open_followup_message_surface",
                    AsyncMock(side_effect=surface_result),
                )
            )
        else:
            mocks["open_followup_message_surface"] = stack.enter_context(
                patch.object(
                    sender_mod,
                    "open_followup_message_surface",
                    AsyncMock(return_value=surface_result),
                )
            )
        mocks["send_sales_navigator_message"] = stack.enter_context(
            patch.object(sender_mod, "send_sales_navigator_message", AsyncMock())
        )
        mocks["send_message"] = stack.enter_context(
            patch.object(sender_mod, "send_message", AsyncMock())
        )
        mocks["close_existing_chat_overlays"] = stack.enter_context(
            patch.object(sender_mod, "close_existing_chat_overlays", AsyncMock(return_value=1))
        )
        mocks["message_send_start"] = stack.enter_context(
            patch.object(sender_mod.logger, "message_send_start", MagicMock())
        )
        mocks["mark_followup_sent"] = stack.enter_context(
            patch.object(sender_mod, "mark_followup_sent", MagicMock())
        )
        mocks["mark_followup_failed"] = stack.enter_context(
            patch.object(sender_mod, "mark_followup_failed", MagicMock())
        )
        mocks["mark_followup_skipped"] = stack.enter_context(
            patch.object(sender_mod, "mark_followup_skipped", MagicMock())
        )
        mocks["_record_reply_at_send_time"] = stack.enter_context(
            patch.object(sender_mod, "_record_reply_at_send_time", MagicMock())
        )
        mocks["extract_last_bubble"] = stack.enter_context(
            patch.object(sender_mod, "extract_last_bubble", AsyncMock(return_value=None))
        )
        mocks["classify_last_sender"] = stack.enter_context(
            patch.object(sender_mod, "classify_last_sender", MagicMock(return_value="us"))
        )
        mocks["resolve_followup_message"] = stack.enter_context(
            patch.object(
                sender_mod,
                "resolve_followup_message",
                MagicMock(return_value=(
                    "Hi Marina,\n\nnur ein kurzer Followup zu meiner letzten Nachricht.\n\n"
                    "Viele Grüße,\nKatharina",
                    2,
                    "draft_text",
                )),
            )
        )
        mocks["random_pause"] = stack.enter_context(
            patch.object(sender_mod, "random_pause", AsyncMock())
        )
        return stack, mocks

    async def test_routes_to_sales_navigator_when_composer_detected(self):
        from unittest.mock import AsyncMock, MagicMock
        from sender import process_followup_one, SURFACE_SALES_NAVIGATOR

        page = self._build_mock_page()
        sales_page = self._build_mock_page()
        context = MagicMock()
        context.new_page = AsyncMock(return_value=page)
        client = MagicMock()
        followup = self._build_followup()

        stack, mocks = self._patches(
            surface_result=(sales_page, SURFACE_SALES_NAVIGATOR),
        )
        with stack:
            result = await process_followup_one(context, client, followup)

        self.assertEqual(result, "sent")
        mocks["send_sales_navigator_message"].assert_awaited_once()
        mocks["send_message"].assert_not_awaited()
        mocks["message_send_start"].assert_called_once()
        mocks["mark_followup_sent"].assert_called_once()
        mocks["mark_followup_failed"].assert_not_called()

        call_args = mocks["send_sales_navigator_message"].await_args
        sent_page, subject, body = call_args.args
        self.assertIs(sent_page, sales_page)
        self.assertEqual(subject, "Kurze Frage zu deiner bAV")
        self.assertIn("\nKatharina", body)
        self.assertIn("Hi Marina", body)

    async def test_routes_to_direct_message_when_dm_surface_returned(self):
        from unittest.mock import AsyncMock, MagicMock
        from sender import process_followup_one, SURFACE_MESSAGE

        page = self._build_mock_page()
        context = MagicMock()
        context.new_page = AsyncMock(return_value=page)
        client = MagicMock()
        followup = self._build_followup()

        stack, mocks = self._patches(
            surface_result=(page, SURFACE_MESSAGE),
        )
        with stack:
            result = await process_followup_one(context, client, followup)

        self.assertEqual(result, "sent")
        mocks["send_message"].assert_awaited_once()
        mocks["send_sales_navigator_message"].assert_not_awaited()
        mocks["message_send_start"].assert_called_once()
        mocks["mark_followup_sent"].assert_called_once()

    async def test_reply_followup_sends_even_when_latest_bubble_is_from_lead(self):
        from unittest.mock import AsyncMock, MagicMock
        from sender import process_followup_one, SURFACE_MESSAGE

        page = self._build_mock_page()
        context = MagicMock()
        context.new_page = AsyncMock(return_value=page)
        client = MagicMock()
        followup = self._build_followup()
        followup["followup_type"] = "REPLY"

        stack, mocks = self._patches(
            surface_result=(page, SURFACE_MESSAGE),
        )
        mocks["extract_last_bubble"].return_value = {
            "sender": "Marina Schulz",
            "text": "Danke dir, passt aktuell nicht.",
            "is_outbound": False,
        }
        mocks["classify_last_sender"].return_value = "lead"
        with stack:
            result = await process_followup_one(context, client, followup)

        self.assertEqual(result, "sent")
        mocks["send_message"].assert_awaited_once()
        mocks["message_send_start"].assert_called_once()
        mocks["mark_followup_sent"].assert_called_once()
        mocks["mark_followup_skipped"].assert_not_called()
        mocks["_record_reply_at_send_time"].assert_not_called()

    async def test_nudge_reply_skip_does_not_log_send_start(self):
        from unittest.mock import AsyncMock, MagicMock
        from sender import process_followup_one, SURFACE_MESSAGE

        page = self._build_mock_page()
        context = MagicMock()
        context.new_page = AsyncMock(return_value=page)
        client = MagicMock()
        followup = self._build_followup()
        followup["followup_type"] = "NUDGE"

        stack, mocks = self._patches(
            surface_result=(page, SURFACE_MESSAGE),
        )
        mocks["extract_last_bubble"].return_value = {
            "sender": "Marina Schulz",
            "text": "Danke, ich melde mich bei Interesse.",
            "is_outbound": False,
        }
        mocks["classify_last_sender"].return_value = "lead"
        with stack:
            result = await process_followup_one(context, client, followup)

        self.assertEqual(result, "skipped")
        mocks["send_message"].assert_not_awaited()
        mocks["send_sales_navigator_message"].assert_not_awaited()
        mocks["message_send_start"].assert_not_called()
        mocks["mark_followup_sent"].assert_not_called()
        mocks["mark_followup_skipped"].assert_called_once_with(
            client,
            followup["id"],
            "reply_detected_at_send_time",
        )
        mocks["_record_reply_at_send_time"].assert_called_once()

    async def test_nudge_own_account_sender_overrides_shared_first_name_reply_match(self):
        from unittest.mock import AsyncMock, MagicMock
        from sender import process_followup_one, SURFACE_MESSAGE

        page = self._build_mock_page()
        context = MagicMock()
        context.new_page = AsyncMock(return_value=page)
        client = MagicMock()
        followup = self._build_followup()
        followup["followup_type"] = "NUDGE"
        followup["lead"]["first_name"] = "Katharina"
        followup["lead"]["last_name"] = "Muster"

        stack, mocks = self._patches(
            surface_result=(page, SURFACE_MESSAGE),
        )
        mocks["extract_last_bubble"].return_value = {
            "sender": "Katharina Hoffmann",
            "text": "Hi Luisa, nur ein kurzer Followup.",
            "is_outbound": False,
        }
        mocks["classify_last_sender"].return_value = "lead"
        with stack:
            result = await process_followup_one(context, client, followup)

        self.assertEqual(result, "sent")
        mocks["send_message"].assert_awaited_once()
        mocks["message_send_start"].assert_called_once()
        mocks["mark_followup_sent"].assert_called_once()
        mocks["mark_followup_skipped"].assert_not_called()
        mocks["_record_reply_at_send_time"].assert_not_called()

    async def test_direct_thread_mismatch_closes_and_reopens_once_before_sending(self):
        from unittest.mock import AsyncMock, MagicMock
        from sender import process_followup_one, SURFACE_MESSAGE

        page = self._build_mock_page()
        context = MagicMock()
        context.new_page = AsyncMock(return_value=page)
        client = MagicMock()
        followup = self._build_followup()
        followup["followup_type"] = "NUDGE"

        stack, mocks = self._patches(
            surface_result=[(page, SURFACE_MESSAGE), (page, SURFACE_MESSAGE)],
        )
        mocks["send_message"].side_effect = [
            RuntimeError(
                "Direct message editor belongs to a different thread "
                "(expected='Marina Schulz', identity='Meysam Azad')."
            ),
            None,
        ]
        with stack:
            result = await process_followup_one(context, client, followup)

        self.assertEqual(result, "sent")
        self.assertEqual(page.goto.await_count, 2)
        self.assertEqual(page.goto.await_args_list[1].args[0], followup["lead"]["linkedin_url"])
        self.assertEqual(mocks["open_followup_message_surface"].await_count, 2)
        self.assertEqual(mocks["send_message"].await_count, 2)
        self.assertGreaterEqual(mocks["close_existing_chat_overlays"].await_count, 1)
        mocks["send_sales_navigator_message"].assert_not_awaited()
        mocks["message_send_start"].assert_called_once()
        mocks["mark_followup_sent"].assert_called_once()
        mocks["mark_followup_failed"].assert_not_called()

    async def test_nudge_mismatched_visible_thread_retries_without_send_start(self):
        from unittest.mock import AsyncMock, MagicMock
        from sender import process_followup_one, SURFACE_MESSAGE

        page = self._build_mock_page()
        context = MagicMock()
        context.new_page = AsyncMock(return_value=page)
        client = MagicMock()
        followup = self._build_followup()
        followup["followup_type"] = "NUDGE"

        stack, mocks = self._patches(
            surface_result=(page, SURFACE_MESSAGE),
        )
        mocks["extract_last_bubble"].return_value = {
            "sender": "Sabrina Lem",
            "text": "Hello. I am in the North America branch.",
            "is_outbound": False,
        }
        mocks["classify_last_sender"].return_value = "unknown"
        with stack:
            result = await process_followup_one(context, client, followup)

        self.assertEqual(result, "retry")
        mocks["send_message"].assert_not_awaited()
        mocks["send_sales_navigator_message"].assert_not_awaited()
        mocks["message_send_start"].assert_not_called()
        mocks["mark_followup_sent"].assert_not_called()
        mocks["mark_followup_failed"].assert_called_once()
        self.assertIn("sender='Sabrina Lem'", mocks["mark_followup_failed"].call_args.args[2])

    async def test_nudge_own_sender_name_is_treated_as_outbound(self):
        from unittest.mock import AsyncMock, MagicMock
        from sender import process_followup_one, SURFACE_MESSAGE

        page = self._build_mock_page()
        context = MagicMock()
        context.new_page = AsyncMock(return_value=page)
        client = MagicMock()
        followup = self._build_followup()
        followup["followup_type"] = "NUDGE"

        stack, mocks = self._patches(
            surface_result=(page, SURFACE_MESSAGE),
        )
        mocks["extract_last_bubble"].return_value = {
            "sender": "Katharina Hoffmann",
            "text": "Hi Marina, nur ein kurzer Followup.",
            "is_outbound": False,
        }
        mocks["classify_last_sender"].return_value = "unknown"
        with stack:
            result = await process_followup_one(context, client, followup)

        self.assertEqual(result, "sent")
        mocks["send_message"].assert_awaited_once()
        mocks["message_send_start"].assert_called_once()
        mocks["mark_followup_sent"].assert_called_once()
        mocks["mark_followup_failed"].assert_not_called()

    async def test_fails_permanently_when_no_surface(self):
        from unittest.mock import AsyncMock, MagicMock
        from sender import process_followup_one

        page = self._build_mock_page()
        context = MagicMock()
        context.new_page = AsyncMock(return_value=page)
        client = MagicMock()
        followup = self._build_followup()

        stack, mocks = self._patches(
            surface_result=RuntimeError("No messaging surface found."),
        )
        with stack:
            result = await process_followup_one(context, client, followup)

        self.assertEqual(result, "failed")
        mocks["send_sales_navigator_message"].assert_not_awaited()
        mocks["send_message"].assert_not_awaited()
        mocks["mark_followup_failed"].assert_called_once()
        kwargs = mocks["mark_followup_failed"].call_args.kwargs
        self.assertTrue(kwargs.get("permanent"))

    async def test_retries_on_transient_failure(self):
        from unittest.mock import AsyncMock, MagicMock
        from sender import process_followup_one

        page = self._build_mock_page()
        context = MagicMock()
        context.new_page = AsyncMock(return_value=page)
        client = MagicMock()
        followup = self._build_followup()

        stack, mocks = self._patches(
            surface_result=RuntimeError("Timeout 5000ms exceeded"),
        )
        with stack:
            result = await process_followup_one(context, client, followup)

        self.assertEqual(result, "retry")
        mocks["mark_followup_failed"].assert_called_once()
        kwargs = mocks["mark_followup_failed"].call_args.kwargs
        self.assertFalse(kwargs.get("permanent"))


if __name__ == "__main__":
    unittest.main()
