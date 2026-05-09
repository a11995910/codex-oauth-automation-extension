import email
import importlib.util
import os
import pathlib
import tempfile
import unittest


ROOT = pathlib.Path(__file__).resolve().parents[1]
MODULE_PATH = ROOT / "scripts" / "qq_openai_code_helper.py"


def load_helper():
    spec = importlib.util.spec_from_file_location("qq_openai_code_helper", MODULE_PATH)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


helper = load_helper()


class QQOpenAICodeHelperTest(unittest.TestCase):
    def test_extract_openai_code_from_duck_forward(self):
        raw = (
            "From: OpenAI <noreply@tm.openai.com>\n"
            "To: demo-alias@duck.com\n"
            "Subject: Your ChatGPT code is 123456\n"
            "Date: Fri, 08 May 2026 10:00:00 +0800\n"
            "Content-Type: text/plain; charset=utf-8\n"
            "\n"
            "Enter this code to continue: 123456\n"
            "Forwarded by DuckDuckGo Email Protection.\n"
        ).encode("utf-8")

        record = helper.parse_message(raw, "INBOX", "42")

        self.assertIsNotNone(record)
        self.assertEqual(record["code"], "123456")
        self.assertEqual(record["primaryAlias"], "demo-alias@duck.com")

    def test_extract_alias_from_delivered_to_header(self):
        message = email.message_from_string(
            "Delivered-To: query-demo@duck.com\n"
            "Subject: Verify your email\n"
            "Content-Type: text/plain; charset=utf-8\n"
            "\n"
            "验证码为 654321"
        )

        aliases = helper.extract_aliases(message, "验证码为 654321")

        self.assertEqual(aliases, ["query-demo@duck.com"])
        self.assertEqual(helper.extract_verification_code("验证码为 654321"), "654321")

    def test_extract_alias_from_pasted_text(self):
        self.assertEqual(
            helper.extract_alias_from_text("客户邮箱：Paste-Demo@duck.com 请查询"),
            "paste-demo@duck.com",
        )
        self.assertEqual(
            helper.extract_alias_from_text("客户邮箱：User-Demo@2925.com 请查询"),
            "user-demo@2925.com",
        )

    def test_record_matches_query_by_duck_alias(self):
        record = {
            "primaryAlias": "first@duck.com",
            "aliases": ["first@duck.com", "second@duck.com"],
            "subject": "Your ChatGPT code is 222333",
            "sender": "OpenAI",
            "preview": "Enter this code",
            "recipients": [],
        }

        self.assertTrue(helper.record_matches_query(record, "second@duck.com"))
        self.assertFalse(helper.record_matches_query(record, "missing@duck.com"))

    def test_record_matches_query_by_generic_email_alias(self):
        record = {
            "primaryAlias": "first@2925.com",
            "aliases": ["first@2925.com", "second@2925.com"],
            "subject": "Your ChatGPT code is 222333",
            "sender": "OpenAI",
            "preview": "Enter this code",
            "recipients": ["second@2925.com"],
        }

        self.assertTrue(helper.record_matches_query(record, "second@2925.com"))
        self.assertFalse(helper.record_matches_query(record, "missing@2925.com"))

    def test_mailbox_scope_separates_providers_and_accounts(self):
        qq_scope = helper.make_mailbox_scope(
            {"provider": "qq", "email": "demo@qq.com"},
            "INBOX",
        )
        mail2925_scope = helper.make_mailbox_scope(
            {"provider": "2925", "email": "demo@2925.com"},
            "INBOX",
        )

        self.assertEqual(qq_scope, "qq:demo@qq.com:INBOX")
        self.assertEqual(mail2925_scope, "2925:demo@2925.com:INBOX")
        self.assertNotEqual(qq_scope, mail2925_scope)

    def test_persist_config_and_records_to_database(self):
        with tempfile.TemporaryDirectory() as tmpdir:
            db_path = pathlib.Path(tmpdir) / "helper.sqlite3"
            old_db_path = os.environ.get("QQ_OPENAI_HELPER_DB_PATH")
            old_imap_db_path = os.environ.get("IMAP_OPENAI_HELPER_DB_PATH")
            os.environ.pop("IMAP_OPENAI_HELPER_DB_PATH", None)
            os.environ["QQ_OPENAI_HELPER_DB_PATH"] = str(db_path)
            helper.DB_INITIALIZED = False
            try:
                helper.init_database()
                config = {
                    "provider": "2925",
                    "email": "demo@2925.com",
                    "password": "mail-password-or-code",
                    "imap_host": "imap.2925mail.com",
                    "imap_port": 993,
                    "mailboxes": ["INBOX"],
                    "max_messages": 20,
                    "poll_interval_seconds": 6,
                }
                helper.save_config_to_db(config)
                self.assertEqual(helper.load_config_from_db()["email"], "demo@2925.com")
                self.assertEqual(helper.load_config_from_db()["provider"], "2925")

                qq_config = {
                    "provider": "qq",
                    "email": "demo@qq.com",
                    "password": "qq-imap-auth-code",
                    "imap_host": "imap.qq.com",
                    "imap_port": 993,
                    "mailboxes": ["INBOX"],
                    "max_messages": 30,
                    "poll_interval_seconds": 8,
                }
                helper.save_config_to_db(qq_config)
                profiles = {profile["provider"]: profile for profile in helper.load_profiles_from_db()}
                self.assertEqual(helper.load_config_from_db()["provider"], "qq")
                self.assertEqual(profiles["2925"]["email"], "demo@2925.com")
                self.assertEqual(profiles["qq"]["email"], "demo@qq.com")

                record = {
                    "id": "INBOX:100",
                    "mailbox": "INBOX",
                    "uid": "100",
                    "aliases": ["saved@duck.com"],
                    "primaryAlias": "saved@duck.com",
                    "code": "112233",
                    "subject": "Your OpenAI code is 112233",
                    "sender": "OpenAI",
                    "recipients": ["saved@duck.com"],
                    "date": "Fri, 08 May 2026 10:00:00 +0800",
                    "timestamp": 1778205600,
                    "preview": "Enter this code",
                    "scannedAt": helper.now_iso(),
                }
                self.assertEqual(helper.insert_records([record]), 1)
                self.assertEqual(helper.insert_records([record]), 0)
                records = helper.find_records("saved@duck.com")
                self.assertEqual(len(records), 1)
                self.assertEqual(records[0]["code"], "112233")
            finally:
                helper.DB_INITIALIZED = False
                if old_db_path is None:
                    os.environ.pop("QQ_OPENAI_HELPER_DB_PATH", None)
                else:
                    os.environ["QQ_OPENAI_HELPER_DB_PATH"] = old_db_path
                if old_imap_db_path is None:
                    os.environ.pop("IMAP_OPENAI_HELPER_DB_PATH", None)
                else:
                    os.environ["IMAP_OPENAI_HELPER_DB_PATH"] = old_imap_db_path


if __name__ == "__main__":
    unittest.main()
