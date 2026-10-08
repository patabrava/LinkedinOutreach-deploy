"""Regression coverage for persisted outbound controls and queue claims."""

import sys
import unittest
from copy import deepcopy
from datetime import datetime, timedelta, timezone
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import AsyncMock, MagicMock, patch

sys.path.insert(0, str(Path(__file__).parent))
sys.path.insert(0, str(Path(__file__).parent / "sender"))

from campaign_management import CampaignControlHeld, outbound_hold_reason, read_outbound_controls, claim_followup


NOW = datetime(2026, 10, 2, 12, tzinfo=timezone.utc)


def lead(**changes):
    return {"id": "lead-1", "linkedin_account_id": "account-1", "linkedin_url": "https://www.linkedin.com/in/person",
            "campaign_paused": False, "sequence_id": 7, "sequence_variant_id": 2,
            "human_handoff_required": False, **changes}


def followup(**changes):
    return {"id": "fu-1", "lead_id": "lead-1", "linkedin_account_id": "account-1", "status": "APPROVED",
            "followup_type": "REPLY", "requires_human": False, "next_send_at": NOW.isoformat(), **changes}


class FakeQuery:
    def __init__(self, client, table):
        self.client, self.table = client, table
        self.filters, self.payload = [], None

    def select(self, *_args, **_kwargs):
        return self

    def eq(self, key, value):
        self.filters.append((key, value))
        return self

    def in_(self, key, values):
        self.filters.append((key, values))
        return self

    def is_(self, key, _value):
        return self.eq(key, None)

    def or_(self, value):
        self.client.due_filters.append(value)
        return self

    def limit(self, _limit):
        return self

    def order(self, *_args, **_kwargs):
        return self

    def update(self, payload):
        self.payload = payload
        return self

    def execute(self):
        if self.client.fail_table == self.table:
            raise RuntimeError("database unavailable")
        rows = self.client.rows.get(self.table, [])
        matched = [row for row in rows if all(
            row.get(key) in value if isinstance(value, list) else row.get(key) == value
            for key, value in self.filters
        )]
        if self.payload:
            if self.client.before_claim:
                self.client.before_claim(rows)
                self.client.before_claim = None
                return self.execute()
            for row in matched:
                row.update(self.payload)
            self.client.updates.append((self.table, self.payload))
        return SimpleNamespace(data=deepcopy(matched), error=None)


class FakeClient:
    def __init__(self, **tables):
        self.rows = tables or {"leads": [lead()], "outreach_sequences": [{"id": 7, "is_active": True}],
                               "outreach_sequence_variants": [{"id": 2, "sequence_id": 7, "is_active": True}],
                               "outbound_suppressions": []}
        self.fail_table, self.before_claim = None, None
        self.updates, self.due_filters = [], []

    def table(self, table):
        return FakeQuery(self, table)


class CampaignReasonTests(unittest.TestCase):
    def reason(self, current=None, **kwargs):
        return outbound_hold_reason(current or lead(), "account-1", sequence={"id": 7, "is_active": True},
                                    variant={"id": 2, "sequence_id": 7, "is_active": True}, now=NOW, **kwargs)

    def test_allowed_and_resumed(self):
        self.assertIsNone(self.reason())
        self.assertIsNone(self.reason(lead(paused_until=(NOW - timedelta(seconds=1)).isoformat())))
        self.assertIsNone(self.reason(lead(stop_reason="reply_received"), followup=followup()))

    def test_holds_pause_stop_handoff_and_ownership_without_mutation(self):
        for changes, expected in [({"campaign_paused": True}, "campaign_paused"),
                                  ({"paused_until": (NOW + timedelta(seconds=1)).isoformat()}, "paused_until"),
                                  ({"paused_until": "invalid"}, "invalid_paused_until"),
                                  ({"stop_reason": "operator_stopped"}, "operator_stopped"),
                                  ({"human_handoff_required": True}, "human_handoff_required"),
                                  ({"linkedin_account_id": "account-2"}, "account_mismatch")]:
            with self.subTest(changes=changes):
                current = lead(**changes)
                self.assertEqual(self.reason(current), expected)
                self.assertEqual(current, lead(**changes))

    def test_inactive_and_mismatched_variants_are_held(self):
        self.assertEqual(outbound_hold_reason(lead(), "account-1", sequence={"is_active": False}), "sequence_inactive")
        self.assertEqual(outbound_hold_reason(lead(), "account-1", sequence={"is_active": True},
                                             variant={"is_active": False}), "variant_inactive")
        self.assertEqual(outbound_hold_reason(lead(), "account-1", sequence={"is_active": True},
                                             variant={"is_active": True, "sequence_id": 8}), "variant_sequence_mismatch")

    def test_suppression_only_allows_one_approved_clear_no_reply(self):
        self.assertEqual(self.reason(suppressed=True), "outbound_suppressed")
        self.assertEqual(self.reason(suppressed=True, followup=followup()), "outbound_suppressed")
        self.assertIsNone(self.reason(suppressed=True, followup=followup(reply_route="clear_no")))
        self.assertEqual(self.reason(suppressed=True, followup=followup(reply_route="clear_no", status="SENT")), "followup_status")
        self.assertEqual(self.reason(suppressed=True, followup=followup(reply_route="clear_no", followup_type="NUDGE")), "outbound_suppressed")

    def test_followup_due_status_human_and_reply_gate(self):
        for changes, expected in [({"status": "PENDING_REVIEW"}, "followup_status"),
                                  ({"next_send_at": (NOW + timedelta(seconds=1)).isoformat()}, "followup_not_due"),
                                  ({"next_send_at": "invalid"}, "invalid_followup_due_time"),
                                  ({"requires_human": True}, "requires_human"),
                                  ({"linkedin_account_id": "account-2"}, "followup_account_mismatch"),
                                  ({"lead_id": "another"}, "followup_lead_mismatch")]:
            with self.subTest(changes=changes):
                self.assertEqual(self.reason(followup=followup(**changes)), expected)
        self.assertEqual(self.reason(lead(stop_reason="reply_received"), followup=followup(followup_type="NUDGE")), "reply_received")
        self.assertIsNone(self.reason(followup=followup(next_send_at=None)))

    def test_every_persisted_stop_holds_except_approved_reply_closure_contract(self):
        for stop_reason in ("nurture", "optout", "appointment_booked", "unknown_stop"):
            with self.subTest(stop_reason=stop_reason):
                self.assertEqual(self.reason(lead(stop_reason=stop_reason)), stop_reason)
                self.assertEqual(self.reason(lead(stop_reason=stop_reason), followup=followup()), stop_reason)
                self.assertEqual(self.reason(lead(stop_reason=stop_reason), followup=followup(reply_route="clear_no"), suppressed=True), stop_reason)
        for stop_reason in ("clear_no", "suppressed", "reply_received"):
            with self.subTest(stop_reason=stop_reason):
                self.assertIsNone(self.reason(lead(stop_reason=stop_reason), followup=followup(reply_route="clear_no"), suppressed=True))
        self.assertEqual(self.reason(lead(stop_reason="clear_no"), followup=followup()), "clear_no")
        self.assertEqual(self.reason(lead(stop_reason="operator_stopped"), followup=followup(reply_route="clear_no")), "operator_stopped")

    def test_managed_campaign_requires_persisted_assigned_variant(self):
        self.assertEqual(outbound_hold_reason(lead(sequence_variant_id=None), "account-1",
                                             sequence={"is_active": True, "is_managed_campaign": True}), "variant_missing")
        self.assertIsNone(outbound_hold_reason(lead(sequence_variant_id=None), "account-1",
                                              sequence={"is_active": True, "is_managed_campaign": False}))

    def test_fresh_reply_timestamp_blocks_nudge_even_without_stop_reason(self):
        self.assertEqual(self.reason(lead(last_reply_at=NOW.isoformat()), followup=followup(followup_type="NUDGE")), "reply_received")
        self.assertIsNone(self.reason(lead(last_reply_at=NOW.isoformat()), followup=followup()))


class CampaignAdapterTests(unittest.TestCase):
    def test_rereads_persisted_pause_instead_of_cached_lead(self):
        client = FakeClient()
        client.rows["leads"][0]["campaign_paused"] = True
        reason, fresh, _fu = read_outbound_controls(client, "lead-1", "account-1", now=NOW)
        self.assertEqual(reason, "campaign_paused")
        self.assertTrue(fresh["campaign_paused"])
        self.assertEqual(client.updates, [])

    def test_adapter_reads_managed_sequence_and_missing_variant(self):
        client = FakeClient()
        client.rows["leads"][0]["sequence_variant_id"] = None
        client.rows["outreach_sequences"][0]["is_managed_campaign"] = True
        self.assertEqual(read_outbound_controls(client, "lead-1", "account-1", now=NOW)[0], "variant_missing")

    def test_database_failures_and_missing_rows_fail_closed(self):
        for table in ("leads", "outreach_sequences", "outreach_sequence_variants", "outbound_suppressions"):
            client = FakeClient()
            client.fail_table = table
            self.assertEqual(read_outbound_controls(client, "lead-1", "account-1", now=NOW)[0], "controls_unavailable")
        self.assertEqual(read_outbound_controls(FakeClient(), "missing", "account-1", now=NOW)[0], "lead_missing")

    def test_expired_suppression_and_processing_claim_ownership(self):
        client = FakeClient()
        client.rows["outbound_suppressions"] = [{"linkedin_url": lead()["linkedin_url"], "expires_at": (NOW - timedelta(seconds=1)).isoformat()}]
        client.rows["followups"] = [followup(status="PROCESSING", processing_started_at="claim-a")]
        args = (client, "lead-1", "account-1")
        self.assertEqual(read_outbound_controls(*args, followup_id="fu-1", processing_started_at="claim-b", now=NOW)[0], "followup_claim_mismatch")
        self.assertIsNone(read_outbound_controls(*args, followup_id="fu-1", processing_started_at="claim-a", now=NOW)[0])
        client.rows["outbound_suppressions"][0]["expires_at"] = "invalid"
        self.assertEqual(read_outbound_controls(*args, now=NOW)[0], "outbound_suppressed")

    def test_conditional_claim_cannot_reclaim_sent_or_rescheduled_followup(self):
        client = FakeClient(followups=[followup()])
        claimed = claim_followup(client, followup(), "account-1", now=NOW)
        self.assertEqual(claimed["status"], "PROCESSING")
        self.assertIsNone(claim_followup(client, followup(), "account-1", now=NOW))
        self.assertTrue(client.due_filters)
        client = FakeClient(followups=[followup()])
        client.before_claim = lambda rows: rows[0].update(next_send_at=(NOW + timedelta(days=1)).isoformat())
        self.assertIsNone(claim_followup(client, followup(), "account-1", now=NOW))

    def test_approved_row_cannot_be_sent_without_a_processing_claim(self):
        client = FakeClient()
        client.rows["followups"] = [followup()]
        self.assertEqual(read_outbound_controls(client, "lead-1", "account-1", followup_id="fu-1", now=NOW)[0], "followup_status")

    def test_targeted_fetch_claims_only_due_approved_rows(self):
        import sender as sender_module
        for changes in ({"status": "SENT"}, {"status": "PENDING_REVIEW"},
                        {"next_send_at": "invalid"}, {"next_send_at": (NOW + timedelta(days=1)).isoformat()},
                        {"requires_human": True}):
            client = FakeClient(followups=[followup(**changes)])
            with patch.object(sender_module, "CURRENT_ACCOUNT_ID", "account-1"), patch.object(sender_module, "claim_followup", wraps=lambda *args, **kwargs: claim_followup(*args, **kwargs, now=NOW)):
                self.assertIsNone(sender_module.fetch_followup_by_id(client, "fu-1"))
            self.assertEqual(client.updates, [])

    def test_targeted_lead_fetch_preserves_due_status_history_and_scope(self):
        import sender as sender_module
        with patch.object(sender_module, "CURRENT_ACCOUNT_ID", "account-1"), \
             patch.object(sender_module, "_utc_now", return_value=NOW):
            for changes in ({"status": "SENT"}, {"status": "PENDING_REVIEW"},
                            {"next_send_at": "invalid"}, {"next_send_at": (NOW + timedelta(days=1)).isoformat()},
                            {"requires_human": True}, {"linkedin_account_id": "account-2"}):
                client = FakeClient(followups=[followup(**changes, lead=lead())])
                self.assertEqual(sender_module.fetch_approved_followups(client, 1, lead_id="lead-1"), [])
                self.assertEqual(client.updates, [])
            client = FakeClient(followups=[followup(lead=lead()), followup(id="other", lead_id="lead-2", lead=lead(id="lead-2"))])
            claimed = sender_module.fetch_approved_followups(client, 1, lead_id="lead-1")
            self.assertEqual([item["id"] for item in claimed], ["fu-1"])
            self.assertEqual(claimed[0]["status"], "PROCESSING")
            self.assertEqual(claimed[0]["processing_started_at"], NOW.isoformat())
            self.assertEqual(client.rows["followups"][1]["status"], "APPROVED")
            self.assertEqual(sender_module.fetch_approved_followups(client, 1, lead_id="lead-1"), [])
            client = FakeClient(followups=[followup(lead=lead()), followup(id="sent", status="SENT", sent_at=NOW.isoformat())])
            self.assertEqual(sender_module.fetch_approved_followups(client, 1, lead_id="lead-1"), [])
            self.assertEqual(client.updates, [])

    def test_first_message_cannot_reclaim_processing_or_sent_lead(self):
        import sender as sender_module
        for status in ("PROCESSING", "SENT", "STOPPED"):
            current = lead(status=status, connection_sent_at=NOW.isoformat())
            client = FakeClient(leads=[current])
            self.assertFalse(sender_module.mark_message_only_processing(client, current))
            self.assertEqual(client.updates, [])

    def test_send_time_history_change_blocks_duplicate_without_rewriting_lead(self):
        import sender as sender_module
        client = FakeClient()
        client.rows["leads"][0]["sent_at"] = NOW.isoformat()
        with patch.object(sender_module, "CURRENT_ACCOUNT_ID", "account-1"):
            self.assertEqual(sender_module.refresh_campaign_controls(client, lead()), "lead_already_sent")
        self.assertEqual(client.updates, [])


class SenderControlHookTests(unittest.IsolatedAsyncioTestCase):
    async def test_final_direct_message_hold_has_no_fallback_click(self):
        from contextlib import ExitStack
        import sender as sender_module
        page = MagicMock(wait_for_timeout=AsyncMock())
        editor = MagicMock()
        message = "Exact configured message"
        guard = MagicMock(side_effect=CampaignControlHeld("campaign_paused"))
        with ExitStack() as stack:
            for name, value in {
                "find_direct_message_editor": (editor, "composer"),
                "assert_direct_message_editor_matches_lead": None,
                "focus_text_field": None, "clear_text_field": None,
                "insert_composer_text": "insert_text", "random_pause": None,
                "read_text_field_text": message, "inspect_send_button_candidates": [],
                "dismiss_keyboard_preference_popover": False,
            }.items():
                stack.enter_context(patch.object(sender_module, name, AsyncMock(return_value=value)))
            stack.enter_context(patch.object(sender_module, "_pick_send_button_candidate", return_value={"enabled": True}))
            send = stack.enter_context(patch.object(sender_module, "click_editor_scoped_send_button", AsyncMock()))
            with self.assertRaises(CampaignControlHeld):
                await sender_module.send_message(page, message, sender_module.SURFACE_MESSAGE, before_send=guard)
        send.assert_not_awaited()
        guard.assert_called_once()

    async def test_first_message_sales_fallback_hold_preserves_lead_state(self):
        from contextlib import ExitStack
        import sender as sender_module
        client = FakeClient()
        current = lead(status="PROCESSING", connection_sent_at=NOW.isoformat())
        client.rows["leads"] = [deepcopy(current)]
        page = MagicMock(goto=AsyncMock(), wait_for_timeout=AsyncMock(), close=AsyncMock())
        page.locator.return_value.count = AsyncMock(return_value=0)
        page.get_by_test_id.return_value.wait_for = AsyncMock()
        context = MagicMock(new_page=AsyncMock(return_value=page))

        async def open_composer(_page):
            client.rows["leads"][0]["campaign_paused"] = True
            return page

        async def submit(*_args, before_send):
            before_send()

        with ExitStack() as stack:
            stack.enter_context(patch.object(sender_module, "CURRENT_ACCOUNT_ID", "account-1"))
            stack.enter_context(patch.object(sender_module, "load_sequence_messages", return_value={"first_message": "Exact configured message"}))
            for name, value in {"random_pause": None, "close_existing_chat_overlays": None,
                                "linkedin_profile_unavailable_reason": None, "first_safe_message_target": (None, 0)}.items():
                stack.enter_context(patch.object(sender_module, name, AsyncMock(return_value=value)))
            stack.enter_context(patch.object(sender_module, "open_sales_navigator_message_surface", AsyncMock(side_effect=open_composer)))
            stack.enter_context(patch.object(sender_module, "send_sales_navigator_message", AsyncMock(side_effect=submit)))
            retry = stack.enter_context(patch.object(sender_module, "mark_lead_retry_later"))
            self.assertEqual(await sender_module.process_message_only_one(context, client, current), "paused")
        retry.assert_not_called()
        self.assertEqual(client.updates, [])
        self.assertEqual(client.rows["leads"][0]["status"], "PROCESSING")

    async def test_final_submit_hold_never_clicks_sales_navigator_send(self):
        import sender as sender_module
        page = MagicMock(wait_for_timeout=AsyncMock())
        body = MagicMock()
        guard = MagicMock(side_effect=CampaignControlHeld("campaign_paused"))
        with patch.object(sender_module, "first_visible_field", AsyncMock(side_effect=[(None, ""), (body, "textarea")])), \
             patch.object(sender_module, "fill_text_field", AsyncMock()), \
             patch.object(sender_module, "click_editor_scoped_send_button", AsyncMock()) as send, \
             patch.object(sender_module, "click_sales_navigator_overlay_send_button", AsyncMock()) as overlay:
            with self.assertRaises(CampaignControlHeld):
                await sender_module.send_sales_navigator_message(page, "Approved subject", "Approved body", before_send=guard)
        send.assert_not_awaited()
        overlay.assert_not_awaited()

    async def test_controls_change_after_opening_page_holds_invite_without_state_rewrite(self):
        import sender as sender_module
        current = lead(outreach_mode="connect_only")
        client = FakeClient()
        client.rows["leads"] = [deepcopy(current)]
        page = MagicMock(close=AsyncMock())
        context = MagicMock(new_page=AsyncMock(return_value=page))

        async def paused_probe(*_args):
            client.rows["leads"][0]["campaign_paused"] = True
            return "invite_available"

        with patch.object(sender_module, "CURRENT_ACCOUNT_ID", "account-1"), \
             patch.object(sender_module, "probe_connect_only_surface", AsyncMock(side_effect=paused_probe)), \
             patch.object(sender_module, "send_connection_request", AsyncMock()) as send:
            self.assertEqual(await sender_module.process_invite_one(context, client, current), "paused")
        send.assert_not_awaited()
        self.assertEqual(client.updates, [])

    async def test_targeted_inmail_cannot_expand_to_batch_or_bypass_history(self):
        import sender as sender_module
        client = FakeClient()
        current = client.rows["leads"][0]
        current.update(status="NEW", batch_id=33)
        with patch.object(sender_module, "CURRENT_ACCOUNT_ID", "account-1"), \
             patch.object(sender_module, "fetch_lead_by_id", side_effect=lambda *_args: dict(current)), \
             patch.object(sender_module, "load_sequence_messages", return_value={"delivery_mode": sender_module.INMAIL_AND_INVITE_MODE}):
            self.assertIsNone(sender_module.fetch_targeted_inmail_lead(client, "lead-1", 33, 10))
            self.assertIsNotNone(sender_module.fetch_targeted_inmail_lead(client, "lead-1", 33, 7))
            current["sent_at"] = NOW.isoformat()
            self.assertIsNone(sender_module.fetch_targeted_inmail_lead(client, "lead-1", 33, 7))

    async def test_all_entry_points_hold_before_browser_or_state_change(self):
        import sender as sender_module
        context = MagicMock(new_page=AsyncMock())
        client = FakeClient()
        client.rows["leads"][0]["campaign_paused"] = True
        with patch.object(sender_module, "CURRENT_ACCOUNT_ID", "account-1"):
            for method in ("process_one", "process_message_only_one", "process_invite_one", "process_inmail_and_invite_one"):
                result = await getattr(sender_module, method)(context, client, lead())
                self.assertEqual(result, "paused", method)
        context.new_page.assert_not_awaited()
        self.assertEqual(client.updates, [])

    async def test_pause_requeues_claimed_followup_and_preserves_due_time(self):
        import sender as sender_module
        client = FakeClient()
        client.rows["leads"][0]["campaign_paused"] = True
        fu = followup(status="PROCESSING", processing_started_at="claim-a", lead=lead())
        client.rows["followups"] = [deepcopy(fu)]
        context = MagicMock(new_page=AsyncMock())
        with patch.object(sender_module, "CURRENT_ACCOUNT_ID", "account-1"):
            self.assertEqual(await sender_module.process_followup_one(context, client, fu), "paused")
        saved = client.rows["followups"][0]
        self.assertEqual(saved["status"], "APPROVED")
        self.assertEqual(saved["last_error"], "outbound_held:campaign_paused")
        self.assertEqual(saved["next_send_at"], NOW.isoformat())
        context.new_page.assert_not_awaited()


if __name__ == "__main__":
    unittest.main()
