#!/usr/bin/env python3
"""IMAP 邮箱 OpenAI 验证码本地查询页面。

用途：
- 通过邮箱 IMAP 读取收件箱。
- 识别邮箱里 OpenAI / ChatGPT 验证码。
- 在页面输入邮箱地址，快速查询对应验证码。

安全边界：
- 服务默认只监听 127.0.0.1。
- IMAP 登录密码或授权码会写入本地 SQLite 数据库，方便服务重启后继续扫描。
"""

from __future__ import annotations

import argparse
import email
import html
import imaplib
import json
import os
import re
import socket
import sqlite3
import threading
import time
import webbrowser
from datetime import datetime, timezone
from email.header import decode_header
from email.message import Message
from email.utils import getaddresses, parsedate_to_datetime
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from typing import Any
from urllib.parse import parse_qs, urlparse


HOST = "127.0.0.1"
PORT = 18769
DEFAULT_PROVIDER = "2925"
DEFAULT_IMAP_HOST = "imap.2925mail.com"
DEFAULT_IMAP_PORT = 993
DEFAULT_MAILBOXES = ["INBOX"]
DEFAULT_MAX_MESSAGES = 80
DEFAULT_POLL_INTERVAL_SECONDS = 6
DEFAULT_DB_PATH = Path(__file__).with_name("qq_openai_helper.sqlite3")
RECENT_RECORD_LIMIT = 120
IMAP_PROVIDER_PRESETS: dict[str, dict[str, Any]] = {
    "2925": {
        "label": "2925 邮箱",
        "imap_host": "imap.2925mail.com",
        "imap_port": 993,
    },
    "qq": {
        "label": "QQ 邮箱",
        "imap_host": "imap.qq.com",
        "imap_port": 993,
    },
    "custom": {
        "label": "自定义 IMAP",
        "imap_host": DEFAULT_IMAP_HOST,
        "imap_port": DEFAULT_IMAP_PORT,
    },
}

OPENAI_KEYWORDS = (
    "openai",
    "chatgpt",
    "noreply@tm.openai.com",
    "account-security@openai.com",
    "verify your email",
    "verification code",
    "log-in code",
    "login code",
    "验证码",
    "代码",
)
FORWARD_KEYWORDS = ("duckduckgo", "duck.com", "forwarded")
EMAIL_PATTERN = re.compile(r"\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b", re.IGNORECASE)
ALIAS_PATTERN = EMAIL_PATTERN
CODE_PATTERNS = (
    re.compile(r"(?:代码为|验证码[^0-9]*?)[\s：:]*(\d{6})"),
    re.compile(r"(?:chatgpt\s+log-?in\s+code|enter\s+this\s+code)[^0-9]{0,40}(\d{6})", re.IGNORECASE),
    re.compile(r"code[:\s]+is[:\s]+(\d{6})|code[:\s]+(\d{6})", re.IGNORECASE),
    re.compile(r"\b(\d{6})\b"),
)

STATE_LOCK = threading.Lock()
DB_LOCK = threading.Lock()
DB_INIT_LOCK = threading.Lock()
DB_INITIALIZED = False
CONFIG: dict[str, Any] = {
    "provider": DEFAULT_PROVIDER,
    "email": "",
    "password": "",
    "imap_host": DEFAULT_IMAP_HOST,
    "imap_port": DEFAULT_IMAP_PORT,
    "mailboxes": DEFAULT_MAILBOXES[:],
    "max_messages": DEFAULT_MAX_MESSAGES,
    "poll_interval_seconds": DEFAULT_POLL_INTERVAL_SECONDS,
}
STATE: dict[str, Any] = {
    "configured": False,
    "running": False,
    "last_scan_at": "",
    "last_error": "",
    "last_message": "等待配置 IMAP 邮箱。",
    "records": [],
}
STOP_EVENT = threading.Event()


def get_db_path() -> Path:
    return Path(
        os.environ.get("IMAP_OPENAI_HELPER_DB_PATH")
        or os.environ.get("QQ_OPENAI_HELPER_DB_PATH")
        or DEFAULT_DB_PATH
    ).expanduser()


def db_connect() -> sqlite3.Connection:
    path = get_db_path()
    path.parent.mkdir(parents=True, exist_ok=True)
    conn = sqlite3.connect(path, timeout=30)
    conn.row_factory = sqlite3.Row
    return conn


def init_database() -> None:
    global DB_INITIALIZED
    with DB_LOCK, db_connect() as conn:
        conn.execute("PRAGMA journal_mode=WAL")
        conn.execute("""
            CREATE TABLE IF NOT EXISTS helper_config (
                id INTEGER PRIMARY KEY CHECK (id = 1),
                provider TEXT NOT NULL DEFAULT '2925',
                email TEXT NOT NULL DEFAULT '',
                password TEXT NOT NULL DEFAULT '',
                imap_host TEXT NOT NULL DEFAULT '',
                imap_port INTEGER NOT NULL DEFAULT 993,
                mailboxes_json TEXT NOT NULL DEFAULT '[]',
                max_messages INTEGER NOT NULL DEFAULT 80,
                poll_interval_seconds INTEGER NOT NULL DEFAULT 6,
                updated_at TEXT NOT NULL DEFAULT ''
            )
        """)
        helper_columns = {
            str(row["name"])
            for row in conn.execute("PRAGMA table_info(helper_config)").fetchall()
        }
        if "provider" not in helper_columns:
            conn.execute("ALTER TABLE helper_config ADD COLUMN provider TEXT NOT NULL DEFAULT '2925'")
        conn.execute("""
            CREATE TABLE IF NOT EXISTS imap_profiles (
                provider TEXT PRIMARY KEY,
                email TEXT NOT NULL DEFAULT '',
                password TEXT NOT NULL DEFAULT '',
                imap_host TEXT NOT NULL DEFAULT '',
                imap_port INTEGER NOT NULL DEFAULT 993,
                mailboxes_json TEXT NOT NULL DEFAULT '[]',
                max_messages INTEGER NOT NULL DEFAULT 80,
                poll_interval_seconds INTEGER NOT NULL DEFAULT 6,
                updated_at TEXT NOT NULL DEFAULT ''
            )
        """)
        conn.execute("""
            CREATE TABLE IF NOT EXISTS mail_records (
                id TEXT PRIMARY KEY,
                mailbox TEXT NOT NULL,
                uid TEXT NOT NULL,
                aliases_json TEXT NOT NULL DEFAULT '[]',
                primary_alias TEXT NOT NULL DEFAULT '',
                code TEXT NOT NULL DEFAULT '',
                subject TEXT NOT NULL DEFAULT '',
                sender TEXT NOT NULL DEFAULT '',
                recipients_json TEXT NOT NULL DEFAULT '[]',
                date_raw TEXT NOT NULL DEFAULT '',
                timestamp REAL NOT NULL DEFAULT 0,
                preview TEXT NOT NULL DEFAULT '',
                scanned_at TEXT NOT NULL DEFAULT '',
                created_at TEXT NOT NULL DEFAULT '',
                UNIQUE (mailbox, uid)
            )
        """)
        conn.execute("""
            CREATE TABLE IF NOT EXISTS mailbox_scan_state (
                mailbox TEXT PRIMARY KEY,
                last_uid INTEGER NOT NULL DEFAULT 0,
                last_scan_at TEXT NOT NULL DEFAULT ''
            )
        """)
        conn.execute("CREATE INDEX IF NOT EXISTS idx_mail_records_primary_alias ON mail_records(primary_alias)")
        conn.execute("CREATE INDEX IF NOT EXISTS idx_mail_records_timestamp ON mail_records(timestamp DESC)")
        existing_profile_count = conn.execute("SELECT COUNT(*) AS total FROM imap_profiles").fetchone()
        current_config = conn.execute("SELECT * FROM helper_config WHERE id = 1").fetchone()
        if (
            current_config
            and int(existing_profile_count["total"] or 0) == 0
            and str(current_config["email"] or "")
        ):
            provider = normalize_provider(current_config["provider"] or infer_provider(current_config))
            conn.execute(
                """
                INSERT OR IGNORE INTO imap_profiles (
                    provider, email, password, imap_host, imap_port, mailboxes_json,
                    max_messages, poll_interval_seconds, updated_at
                )
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
                """,
                (
                    provider,
                    str(current_config["email"] or ""),
                    str(current_config["password"] or ""),
                    str(current_config["imap_host"] or provider_default(provider, "imap_host")),
                    int(current_config["imap_port"] or provider_default(provider, "imap_port")),
                    str(current_config["mailboxes_json"] or "[]"),
                    int(current_config["max_messages"] or DEFAULT_MAX_MESSAGES),
                    int(current_config["poll_interval_seconds"] or DEFAULT_POLL_INTERVAL_SECONDS),
                    str(current_config["updated_at"] or now_iso()),
                ),
            )
        conn.commit()
    DB_INITIALIZED = True


def ensure_database() -> None:
    if DB_INITIALIZED:
        return
    with DB_INIT_LOCK:
        if not DB_INITIALIZED:
            init_database()


def json_dumps(value: Any) -> str:
    return json.dumps(value, ensure_ascii=False)


def json_loads_list(value: object) -> list[Any]:
    try:
        parsed = json.loads(str(value or "[]"))
        return parsed if isinstance(parsed, list) else []
    except Exception:
        return []


def now_iso() -> str:
    return datetime.now(timezone.utc).isoformat().replace("+00:00", "Z")


def compact_text(value: object, limit: int = 600) -> str:
    text = re.sub(r"\s+", " ", str(value or "")).strip()
    return text[:limit]


def normalize_alias(value: object) -> str:
    return str(value or "").strip().lower()


def extract_alias_from_text(value: object) -> str:
    match = ALIAS_PATTERN.search(str(value or ""))
    return normalize_alias(match.group(0)) if match else normalize_alias(value)


def is_email_query(value: object) -> bool:
    return bool(EMAIL_PATTERN.fullmatch(normalize_alias(value)))


def normalize_provider(value: object) -> str:
    provider = str(value or "").strip().lower()
    if provider in {"2925", "mail2925"}:
        return "2925"
    if provider in {"qq", "qqmail", "qq_mail"}:
        return "qq"
    if provider in IMAP_PROVIDER_PRESETS:
        return provider
    return "custom"


def provider_default(provider: object, key: str) -> Any:
    preset = IMAP_PROVIDER_PRESETS.get(normalize_provider(provider)) or IMAP_PROVIDER_PRESETS[DEFAULT_PROVIDER]
    return preset.get(key)


def make_mailbox_scope(config: dict[str, Any], mailbox: object) -> str:
    provider = normalize_provider(config.get("provider") or infer_provider(config))
    email_address = normalize_alias(config.get("email"))
    mailbox_name = str(mailbox or "").strip() or "INBOX"
    return f"{provider}:{email_address}:{mailbox_name}"


def get_mapping_value(mapping: object, key: str, default: Any = "") -> Any:
    if isinstance(mapping, sqlite3.Row):
        return mapping[key] if key in mapping.keys() else default
    if isinstance(mapping, dict):
        return mapping.get(key, default)
    return default


def infer_provider(config: object) -> str:
    provider = str(get_mapping_value(config, "provider", "") or "").strip()
    if provider:
        return normalize_provider(provider)
    host = str(get_mapping_value(config, "imap_host", "") or "").lower()
    email_address = str(get_mapping_value(config, "email", "") or "").lower()
    if "qq.com" in host or email_address.endswith("@qq.com"):
        return "qq"
    if "2925" in host or email_address.endswith("@2925.com"):
        return "2925"
    return "custom"


def parse_mailboxes(value: object) -> list[str]:
    if isinstance(value, list):
        parts = value
    else:
        parts = re.split(r"[\r\n,，]+", str(value or ""))
    mailboxes = []
    for item in parts:
        mailbox = str(item or "").strip()
        if mailbox and mailbox not in mailboxes:
            mailboxes.append(mailbox)
    return mailboxes or DEFAULT_MAILBOXES[:]


def row_to_record(row: sqlite3.Row) -> dict[str, Any]:
    return {
        "id": str(row["id"] or ""),
        "mailbox": str(row["mailbox"] or ""),
        "uid": str(row["uid"] or ""),
        "aliases": [str(item) for item in json_loads_list(row["aliases_json"])],
        "primaryAlias": str(row["primary_alias"] or ""),
        "code": str(row["code"] or ""),
        "subject": str(row["subject"] or ""),
        "sender": str(row["sender"] or ""),
        "recipients": [str(item) for item in json_loads_list(row["recipients_json"])],
        "date": str(row["date_raw"] or ""),
        "timestamp": float(row["timestamp"] or 0),
        "preview": str(row["preview"] or ""),
        "scannedAt": str(row["scanned_at"] or ""),
    }


def save_config_to_db(config: dict[str, Any]) -> None:
    ensure_database()
    provider = normalize_provider(config.get("provider") or infer_provider(config))
    email_address = str(config.get("email") or "")
    password = str(config.get("password") or "")
    imap_host = str(config.get("imap_host") or provider_default(provider, "imap_host") or DEFAULT_IMAP_HOST)
    imap_port = int(config.get("imap_port") or provider_default(provider, "imap_port") or DEFAULT_IMAP_PORT)
    mailboxes_json = json_dumps(parse_mailboxes(config.get("mailboxes")))
    max_messages = int(config.get("max_messages") or DEFAULT_MAX_MESSAGES)
    poll_interval = int(config.get("poll_interval_seconds") or DEFAULT_POLL_INTERVAL_SECONDS)
    updated_at = now_iso()
    with DB_LOCK, db_connect() as conn:
        conn.execute(
            """
            INSERT INTO helper_config (
                id, provider, email, password, imap_host, imap_port, mailboxes_json,
                max_messages, poll_interval_seconds, updated_at
            )
            VALUES (1, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            ON CONFLICT(id) DO UPDATE SET
                provider = excluded.provider,
                email = excluded.email,
                password = excluded.password,
                imap_host = excluded.imap_host,
                imap_port = excluded.imap_port,
                mailboxes_json = excluded.mailboxes_json,
                max_messages = excluded.max_messages,
                poll_interval_seconds = excluded.poll_interval_seconds,
                updated_at = excluded.updated_at
            """,
            (
                provider,
                email_address,
                password,
                imap_host,
                imap_port,
                mailboxes_json,
                max_messages,
                poll_interval,
                updated_at,
            ),
        )
        conn.execute(
            """
            INSERT INTO imap_profiles (
                provider, email, password, imap_host, imap_port, mailboxes_json,
                max_messages, poll_interval_seconds, updated_at
            )
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
            ON CONFLICT(provider) DO UPDATE SET
                email = excluded.email,
                password = excluded.password,
                imap_host = excluded.imap_host,
                imap_port = excluded.imap_port,
                mailboxes_json = excluded.mailboxes_json,
                max_messages = excluded.max_messages,
                poll_interval_seconds = excluded.poll_interval_seconds,
                updated_at = excluded.updated_at
            """,
            (
                provider,
                email_address,
                password,
                imap_host,
                imap_port,
                mailboxes_json,
                max_messages,
                poll_interval,
                updated_at,
            ),
        )
        conn.commit()


def row_to_config(row: sqlite3.Row) -> dict[str, Any]:
    provider = infer_provider(row)
    return {
        "provider": provider,
        "email": str(row["email"] or ""),
        "password": str(row["password"] or ""),
        "imap_host": str(row["imap_host"] or provider_default(provider, "imap_host") or DEFAULT_IMAP_HOST),
        "imap_port": int(row["imap_port"] or provider_default(provider, "imap_port") or DEFAULT_IMAP_PORT),
        "mailboxes": parse_mailboxes(json_loads_list(row["mailboxes_json"])),
        "max_messages": int(row["max_messages"] or DEFAULT_MAX_MESSAGES),
        "poll_interval_seconds": int(row["poll_interval_seconds"] or DEFAULT_POLL_INTERVAL_SECONDS),
    }


def load_config_from_db() -> dict[str, Any] | None:
    ensure_database()
    with DB_LOCK, db_connect() as conn:
        row = conn.execute("SELECT * FROM helper_config WHERE id = 1").fetchone()
    if not row:
        return None
    return row_to_config(row)


def load_profile_from_db(provider: object) -> dict[str, Any] | None:
    ensure_database()
    normalized = normalize_provider(provider)
    with DB_LOCK, db_connect() as conn:
        row = conn.execute("SELECT * FROM imap_profiles WHERE provider = ?", (normalized,)).fetchone()
    return row_to_config(row) if row else None


def load_profiles_from_db() -> list[dict[str, Any]]:
    ensure_database()
    with DB_LOCK, db_connect() as conn:
        rows = conn.execute("SELECT * FROM imap_profiles ORDER BY provider").fetchall()
    return [row_to_config(row) for row in rows]


def load_persisted_config() -> None:
    config = load_config_from_db()
    if not config or not config.get("email") or not config.get("password"):
        return
    with STATE_LOCK:
        CONFIG.update(config)
        STATE.update({
            "configured": True,
            "running": True,
            "last_message": "已从数据库加载邮箱配置，后台监控已启动。",
        })


def insert_records(records: list[dict[str, Any]]) -> int:
    ensure_database()
    if not records:
        return 0
    inserted = 0
    created_at = now_iso()
    with DB_LOCK, db_connect() as conn:
        for record in records:
            cursor = conn.execute(
                """
                INSERT OR IGNORE INTO mail_records (
                    id, mailbox, uid, aliases_json, primary_alias, code, subject,
                    sender, recipients_json, date_raw, timestamp, preview, scanned_at, created_at
                )
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                """,
                (
                    str(record.get("id") or ""),
                    str(record.get("mailbox") or ""),
                    str(record.get("uid") or ""),
                    json_dumps(record.get("aliases") or []),
                    str(record.get("primaryAlias") or ""),
                    str(record.get("code") or ""),
                    str(record.get("subject") or ""),
                    str(record.get("sender") or ""),
                    json_dumps(record.get("recipients") or []),
                    str(record.get("date") or ""),
                    float(record.get("timestamp") or 0),
                    str(record.get("preview") or ""),
                    str(record.get("scannedAt") or now_iso()),
                    created_at,
                ),
            )
            inserted += int(cursor.rowcount == 1)
        conn.commit()
    return inserted


def get_recent_records(limit: int = RECENT_RECORD_LIMIT) -> list[dict[str, Any]]:
    ensure_database()
    with DB_LOCK, db_connect() as conn:
        rows = conn.execute(
            """
            SELECT * FROM mail_records
            ORDER BY timestamp DESC, scanned_at DESC
            LIMIT ?
            """,
            (max(1, int(limit)),),
        ).fetchall()
    return [row_to_record(row) for row in rows]


def get_last_uid(mailbox: str) -> int:
    ensure_database()
    with DB_LOCK, db_connect() as conn:
        row = conn.execute(
            "SELECT last_uid FROM mailbox_scan_state WHERE mailbox = ?",
            (mailbox,),
        ).fetchone()
    return int(row["last_uid"] or 0) if row else 0


def set_last_uid(mailbox: str, last_uid: int) -> None:
    ensure_database()
    with DB_LOCK, db_connect() as conn:
        conn.execute(
            """
            INSERT INTO mailbox_scan_state (mailbox, last_uid, last_scan_at)
            VALUES (?, ?, ?)
            ON CONFLICT(mailbox) DO UPDATE SET
                last_uid = MAX(mailbox_scan_state.last_uid, excluded.last_uid),
                last_scan_at = excluded.last_scan_at
            """,
            (mailbox, max(0, int(last_uid)), now_iso()),
        )
        conn.commit()


def get_records_for_query(query: str = "", limit: int = RECENT_RECORD_LIMIT) -> list[dict[str, Any]]:
    ensure_database()
    target = extract_alias_from_text(query)
    sql = "SELECT * FROM mail_records"
    params: list[Any] = []
    if target:
        if is_email_query(target):
            sql += " WHERE primary_alias = ? OR aliases_json LIKE ? OR recipients_json LIKE ?"
            like = f"%{target}%"
            params.extend([target, like, like])
        else:
            like = f"%{target}%"
            sql += """
                WHERE primary_alias LIKE ?
                   OR aliases_json LIKE ?
                   OR recipients_json LIKE ?
                   OR subject LIKE ?
                   OR sender LIKE ?
                   OR preview LIKE ?
            """
            params.extend([like, like, like, like, like, like])
    sql += " ORDER BY timestamp DESC, scanned_at DESC LIMIT ?"
    params.append(max(1, int(limit)))
    with DB_LOCK, db_connect() as conn:
        rows = conn.execute(sql, params).fetchall()
    records = [row_to_record(row) for row in rows]
    return [record for record in records if record_matches_query(record, target)]


def decode_mime_header(value: object) -> str:
    raw = str(value or "")
    if not raw:
        return ""
    try:
        parts = decode_header(raw)
        decoded = []
        for chunk, charset in parts:
            if isinstance(chunk, bytes):
                decoded.append(chunk.decode(charset or "utf-8", errors="replace"))
            else:
                decoded.append(str(chunk))
        return "".join(decoded).strip()
    except Exception:
        return raw.strip()


def extract_body_text(message: Message) -> str:
    parts: list[str] = []
    if message.is_multipart():
        for part in message.walk():
            content_type = str(part.get_content_type() or "").lower()
            disposition = str(part.get("Content-Disposition") or "").lower()
            if "attachment" in disposition:
                continue
            if content_type not in {"text/plain", "text/html"}:
                continue
            payload = part.get_payload(decode=True)
            if payload is None:
                continue
            charset = part.get_content_charset() or "utf-8"
            text = payload.decode(charset, errors="replace")
            if content_type == "text/html":
                text = strip_html(text)
            parts.append(text)
    else:
        payload = message.get_payload(decode=True)
        if payload is not None:
            charset = message.get_content_charset() or "utf-8"
            text = payload.decode(charset, errors="replace")
            if str(message.get_content_type() or "").lower() == "text/html":
                text = strip_html(text)
            parts.append(text)
    return "\n".join(parts)


def strip_html(value: str) -> str:
    text = re.sub(r"(?is)<(script|style).*?>.*?</\1>", " ", value or "")
    text = re.sub(r"(?is)<br\s*/?>", "\n", text)
    text = re.sub(r"(?is)</p\s*>", "\n", text)
    text = re.sub(r"(?is)<[^>]+>", " ", text)
    return html.unescape(text)


def get_header_values(message: Message, names: list[str]) -> list[str]:
    values: list[str] = []
    for name in names:
        for value in message.get_all(name, []):
            decoded = decode_mime_header(value)
            if decoded:
                values.append(decoded)
    return values


def extract_aliases(message: Message, body_text: str) -> list[str]:
    header_names = [
        "To",
        "Cc",
        "Bcc",
        "Delivered-To",
        "X-Original-To",
        "X-Forwarded-To",
        "Apparently-To",
        "Envelope-To",
        "Resent-To",
    ]
    source = "\n".join(get_header_values(message, header_names) + [body_text])
    aliases = []
    for match in ALIAS_PATTERN.findall(source):
        alias = normalize_alias(match)
        if alias and alias not in aliases:
            aliases.append(alias)
    return aliases


def extract_verification_code(text: str) -> str:
    for pattern in CODE_PATTERNS:
        match = pattern.search(text or "")
        if match:
            return next((item for item in match.groups() if item), "")
    return ""


def is_openai_related(message: Message, body_text: str) -> bool:
    sender = " ".join(get_header_values(message, ["From", "Sender", "Return-Path"]))
    subject = decode_mime_header(message.get("Subject", ""))
    combined = f"{sender}\n{subject}\n{body_text}".lower()
    has_openai = any(keyword.lower() in combined for keyword in OPENAI_KEYWORDS)
    has_forward_marker = any(keyword.lower() in combined for keyword in FORWARD_KEYWORDS)
    return has_openai or has_forward_marker


def parse_message(raw_bytes: bytes, mailbox: str, uid: str) -> dict[str, Any] | None:
    message = email.message_from_bytes(raw_bytes)
    subject = decode_mime_header(message.get("Subject", ""))
    sender = decode_mime_header(message.get("From", ""))
    body_text = extract_body_text(message)
    combined_text = f"{subject}\n{sender}\n{body_text}"
    code = extract_verification_code(combined_text)
    aliases = extract_aliases(message, body_text)
    if not code or not is_openai_related(message, body_text):
        return None

    date_raw = str(message.get("Date") or "").strip()
    timestamp = 0.0
    try:
        parsed_date = parsedate_to_datetime(date_raw)
        if parsed_date:
            timestamp = parsed_date.timestamp()
    except Exception:
        timestamp = 0.0

    recipients = []
    for value in get_header_values(message, ["To", "Cc", "Delivered-To", "X-Original-To", "X-Forwarded-To"]):
        recipients.extend([addr for _, addr in getaddresses([value]) if addr])

    return {
        "id": f"{mailbox}:{uid}",
        "mailbox": mailbox,
        "uid": uid,
        "aliases": aliases,
        "primaryAlias": aliases[0] if aliases else "",
        "code": code,
        "subject": subject,
        "sender": sender,
        "recipients": recipients,
        "date": date_raw,
        "timestamp": timestamp,
        "preview": compact_text(body_text, 240),
        "scannedAt": now_iso(),
    }


def connect_imap(config: dict[str, Any]) -> imaplib.IMAP4_SSL:
    client = imaplib.IMAP4_SSL(
        str(config.get("imap_host") or DEFAULT_IMAP_HOST),
        int(config.get("imap_port") or DEFAULT_IMAP_PORT),
        timeout=30,
    )
    client.login(str(config.get("email") or ""), str(config.get("password") or ""))
    return client


def imap_today_since() -> str:
    return datetime.now().strftime("%d-%b-%Y")


def fetch_recent_records(config: dict[str, Any]) -> list[dict[str, Any]]:
    records: list[dict[str, Any]] = []
    max_messages = max(1, min(500, int(config.get("max_messages") or DEFAULT_MAX_MESSAGES)))
    client = connect_imap(config)
    try:
        for mailbox in parse_mailboxes(config.get("mailboxes")):
            mailbox_scope = make_mailbox_scope(config, mailbox)
            try:
                status, _ = client.select(mailbox, readonly=True)
                if status != "OK":
                    continue
                status, data = client.uid("search", None, "SINCE", imap_today_since())
                if status != "OK" or not data or not data[0]:
                    continue
                all_uids = [
                    uid_bytes.decode("ascii", errors="ignore")
                    for uid_bytes in data[0].split()
                ]
                last_uid = get_last_uid(mailbox_scope)
                new_uids = [uid for uid in all_uids if uid.isdigit() and int(uid) > last_uid]
                uids = new_uids[-max_messages:]
                max_seen_uid = max([last_uid] + [int(uid) for uid in new_uids if uid.isdigit()])
                for uid_bytes in reversed(uids):
                    uid = str(uid_bytes)
                    status, msg_data = client.uid("fetch", uid, "(RFC822)")
                    if status != "OK" or not msg_data:
                        continue
                    raw = next((item[1] for item in msg_data if isinstance(item, tuple) and item[1]), None)
                    if not raw:
                        continue
                    record = parse_message(raw, mailbox_scope, uid)
                    if record:
                        records.append(record)
                if max_seen_uid > last_uid:
                    set_last_uid(mailbox_scope, max_seen_uid)
            except Exception as exc:
                set_state(last_error=f"读取邮箱目录 {mailbox} 失败：{exc}")
    finally:
        try:
            client.logout()
        except Exception:
            pass
    return dedupe_records(records)


def dedupe_records(records: list[dict[str, Any]]) -> list[dict[str, Any]]:
    seen = set()
    deduped = []
    for record in sorted(records, key=lambda item: float(item.get("timestamp") or 0), reverse=True):
        key = record.get("id") or f"{record.get('primaryAlias')}:{record.get('code')}:{record.get('date')}"
        if key in seen:
            continue
        seen.add(key)
        deduped.append(record)
    return deduped


def set_state(**updates: Any) -> None:
    with STATE_LOCK:
        STATE.update(updates)


def get_state_snapshot() -> dict[str, Any]:
    with STATE_LOCK:
        state = dict(STATE)
        config = dict(CONFIG)
    records = get_recent_records()
    return {
        **state,
        "records": records,
        "config": serialize_config_for_admin(config, include_db_path=True),
        "profiles": [
            serialize_config_for_admin(profile)
            for profile in load_profiles_from_db()
        ],
    }


def serialize_config_for_admin(config: dict[str, Any], include_db_path: bool = False) -> dict[str, Any]:
    provider = normalize_provider(config.get("provider") or infer_provider(config))
    serialized = {
        "provider": provider,
        "provider_label": str(provider_default(provider, "label") or provider),
        "email": str(config.get("email") or ""),
        "masked_email": mask_email(config.get("email")),
        "has_password": bool(config.get("password")),
        "imap_host": config.get("imap_host") or provider_default(provider, "imap_host"),
        "imap_port": config.get("imap_port") or provider_default(provider, "imap_port"),
        "mailboxes": config.get("mailboxes"),
        "max_messages": config.get("max_messages"),
        "poll_interval_seconds": config.get("poll_interval_seconds"),
    }
    if include_db_path:
        serialized["db_path"] = str(get_db_path())
    return serialized


def mask_email(value: object) -> str:
    text = str(value or "").strip()
    if "@" not in text:
        return text[:2] + "***" if text else ""
    name, domain = text.split("@", 1)
    if len(name) <= 2:
        return f"{name[:1]}***@{domain}"
    return f"{name[:2]}***@{domain}"


def update_records(records: list[dict[str, Any]], message: str = "") -> None:
    inserted = insert_records(records)
    recent_records = get_recent_records()
    set_state(
        records=recent_records,
        last_scan_at=now_iso(),
        last_error="",
        last_message=message or f"本次扫描到 {len(records)} 条验证码邮件，新增 {inserted} 条，数据库共显示最近 {len(recent_records)} 条。",
    )


def scan_once() -> list[dict[str, Any]]:
    with STATE_LOCK:
        config = dict(CONFIG)
        configured = bool(STATE.get("configured"))
    if not configured:
        raise RuntimeError("请先配置 IMAP 邮箱和密码/授权码。")
    records = fetch_recent_records(config)
    update_records(records)
    return records


def monitor_loop() -> None:
    while not STOP_EVENT.is_set():
        with STATE_LOCK:
            configured = bool(STATE.get("configured"))
            interval = max(2, min(120, int(CONFIG.get("poll_interval_seconds") or DEFAULT_POLL_INTERVAL_SECONDS)))
        if configured:
            try:
                scan_once()
            except Exception as exc:
                set_state(last_error=str(exc), last_message=f"扫描失败：{exc}")
        STOP_EVENT.wait(interval)


def find_latest_record(alias: str = "") -> dict[str, Any] | None:
    records = find_records(alias)
    return records[0] if records else None


def record_matches_query(record: dict[str, Any], query: str = "") -> bool:
    target = extract_alias_from_text(query)
    if not target:
        return True
    aliases = [normalize_alias(item) for item in record.get("aliases") or []]
    searchable = "\n".join([
        normalize_alias(record.get("primaryAlias")),
        "\n".join(aliases),
        normalize_alias(record.get("subject")),
        normalize_alias(record.get("sender")),
        normalize_alias(record.get("preview")),
        "\n".join(normalize_alias(item) for item in record.get("recipients") or []),
    ])
    if is_email_query(target):
        return target in aliases or normalize_alias(record.get("primaryAlias")) == target
    return target in searchable


def find_records(query: str = "") -> list[dict[str, Any]]:
    target = extract_alias_from_text(query)
    return get_records_for_query(target)


def json_response(handler: BaseHTTPRequestHandler, status: int, payload: dict[str, Any]) -> None:
    body = json.dumps(payload, ensure_ascii=False).encode("utf-8")
    handler.send_response(status)
    handler.send_header("Content-Type", "application/json; charset=utf-8")
    handler.send_header("Content-Length", str(len(body)))
    handler.send_header("Access-Control-Allow-Origin", "*")
    handler.send_header("Access-Control-Allow-Headers", "Content-Type")
    handler.send_header("Access-Control-Allow-Methods", "GET, POST, OPTIONS")
    handler.end_headers()
    handler.wfile.write(body)


def read_json_payload(handler: BaseHTTPRequestHandler) -> dict[str, Any]:
    length = int(handler.headers.get("Content-Length", "0") or 0)
    raw = handler.rfile.read(length) if length > 0 else b"{}"
    try:
        return json.loads(raw.decode("utf-8"))
    except Exception as exc:
        raise RuntimeError(f"请求 JSON 无法解析：{exc}") from exc


class HelperHandler(BaseHTTPRequestHandler):
    server_version = "IMAPOpenAICodeHelper/1.0"

    def log_message(self, format: str, *args: Any) -> None:  # noqa: A003
        print(f"[IMAPCodeHelper] {self.address_string()} {format % args}", flush=True)

    def do_OPTIONS(self) -> None:
        json_response(self, 200, {"ok": True})

    def do_GET(self) -> None:
        parsed = urlparse(self.path)
        if parsed.path == "/favicon.ico":
            self.send_response(204)
            self.end_headers()
            return
        if parsed.path in {"/", "/index.html"}:
            self.render_page(ADMIN_PAGE_HTML)
            return
        if parsed.path in {"/admin", "/admin.html"}:
            self.render_page(ADMIN_PAGE_HTML)
            return
        if parsed.path in {"/client", "/client.html", "/query"}:
            self.render_page(CLIENT_PAGE_HTML)
            return
        if parsed.path == "/api/status":
            json_response(self, 200, {"ok": True, **get_state_snapshot()})
            return
        if parsed.path == "/api/latest":
            query = parse_qs(parsed.query)
            lookup = query.get("alias", query.get("q", [""]))[0]
            record = find_latest_record(lookup)
            json_response(self, 200, {"ok": True, "record": record, "code": record.get("code") if record else ""})
            return
        if parsed.path == "/api/records":
            query = parse_qs(parsed.query)
            lookup = query.get("alias", query.get("q", [""]))[0]
            records = find_records(lookup)
            json_response(self, 200, {"ok": True, "records": records})
            return
        json_response(self, 404, {"ok": False, "error": "接口不存在"})

    def do_POST(self) -> None:
        parsed = urlparse(self.path)
        try:
            if parsed.path == "/api/config":
                payload = read_json_payload(self)
                apply_config(payload)
                try:
                    records = scan_once()
                    message = f"配置已保存，本次扫描到 {len(records)} 条验证码邮件。"
                except Exception as exc:
                    message = f"配置已保存，但首次扫描失败：{exc}"
                    set_state(last_error=str(exc), last_message=message)
                json_response(self, 200, {"ok": True, "message": message, **get_state_snapshot()})
                return
            if parsed.path == "/api/scan":
                records = scan_once()
                json_response(self, 200, {"ok": True, "records": records, **get_state_snapshot()})
                return
            json_response(self, 404, {"ok": False, "error": "接口不存在"})
        except Exception as exc:
            set_state(last_error=str(exc), last_message=f"请求处理失败：{exc}")
            json_response(self, 400, {"ok": False, "error": str(exc), **get_state_snapshot()})

    def render_page(self, html_text: str) -> None:
        body = html_text.encode("utf-8")
        self.send_response(200)
        self.send_header("Content-Type", "text/html; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)


def apply_config(payload: dict[str, Any]) -> None:
    provider = normalize_provider(payload.get("provider") or infer_provider(payload))
    imap_email = str(payload.get("email") or "").strip()
    password = str(payload.get("password") or "").strip()
    if not is_email_query(imap_email):
        raise RuntimeError("请填写完整邮箱地址。")
    with STATE_LOCK:
        active_provider = normalize_provider(CONFIG.get("provider") or infer_provider(CONFIG))
        active_password = str(CONFIG.get("password") or "")
    saved_profile = load_profile_from_db(provider)
    previous_password = str((saved_profile or {}).get("password") or "")
    if not previous_password and active_provider == provider:
        previous_password = active_password
    if not password:
        password = previous_password
    if not password:
        raise RuntimeError("请填写 IMAP 密码或授权码。")

    imap_host = str(payload.get("imap_host") or provider_default(provider, "imap_host") or DEFAULT_IMAP_HOST).strip()
    imap_port = int(payload.get("imap_port") or provider_default(provider, "imap_port") or DEFAULT_IMAP_PORT)
    if imap_port <= 0 or imap_port > 65535:
        raise RuntimeError("IMAP 端口不合法。")
    max_messages = max(1, min(500, int(payload.get("max_messages") or DEFAULT_MAX_MESSAGES)))
    poll_interval = max(2, min(120, int(payload.get("poll_interval_seconds") or DEFAULT_POLL_INTERVAL_SECONDS)))
    mailboxes = parse_mailboxes(payload.get("mailboxes"))

    with STATE_LOCK:
        next_config = {
            "provider": provider,
            "email": imap_email,
            "password": password,
            "imap_host": imap_host,
            "imap_port": imap_port,
            "mailboxes": mailboxes,
            "max_messages": max_messages,
            "poll_interval_seconds": poll_interval,
        }
        CONFIG.update({
            "provider": provider,
            "email": imap_email,
            "password": password,
            "imap_host": imap_host,
            "imap_port": imap_port,
            "mailboxes": mailboxes,
            "max_messages": max_messages,
            "poll_interval_seconds": poll_interval,
        })
        STATE.update({
            "configured": True,
            "running": True,
            "last_message": "配置已保存，后台监控已启动。",
        })
    save_config_to_db(next_config)


ADMIN_PAGE_HTML = r"""<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>IMAP OpenAI 验证码后台</title>
  <style>
    :root {
      color-scheme: light;
      --bg: #f6f7f9;
      --panel: #ffffff;
      --text: #172033;
      --muted: #687386;
      --line: #d8dee8;
      --brand: #1f6feb;
      --danger: #b42318;
      --ok: #147a3d;
    }
    * { box-sizing: border-box; }
    body {
      margin: 0;
      font: 14px/1.55 -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
      color: var(--text);
      background: var(--bg);
    }
    header {
      padding: 18px 22px;
      border-bottom: 1px solid var(--line);
      background: var(--panel);
    }
    h1 { margin: 0; font-size: 18px; }
    .topline {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 12px;
    }
    .nav-link {
      border: 1px solid var(--line);
      border-radius: 6px;
      color: var(--brand);
      text-decoration: none;
      padding: 7px 10px;
      white-space: nowrap;
    }
    main {
      width: min(1120px, calc(100vw - 32px));
      margin: 18px auto 40px;
      display: grid;
      grid-template-columns: minmax(320px, 420px) minmax(0, 1fr);
      gap: 16px;
    }
    section {
      background: var(--panel);
      border: 1px solid var(--line);
      border-radius: 8px;
      padding: 16px;
    }
    h2 { margin: 0 0 12px; font-size: 15px; }
    label { display: block; margin: 10px 0 6px; color: var(--muted); }
    input, select, textarea {
      width: 100%;
      border: 1px solid var(--line);
      border-radius: 6px;
      padding: 9px 10px;
      font: inherit;
      color: var(--text);
      background: #fff;
    }
    textarea { min-height: 74px; resize: vertical; }
    .row { display: grid; grid-template-columns: 1fr 92px; gap: 8px; }
    .actions { display: flex; gap: 8px; margin-top: 14px; flex-wrap: wrap; }
    button {
      border: 1px solid var(--brand);
      background: var(--brand);
      color: #fff;
      border-radius: 6px;
      padding: 8px 12px;
      font: inherit;
      cursor: pointer;
    }
    button.secondary { background: #fff; color: var(--brand); }
    button:disabled { opacity: .55; cursor: wait; }
    .status {
      margin-top: 12px;
      padding: 10px;
      border-radius: 6px;
      background: #f2f5fb;
      color: var(--muted);
      white-space: pre-wrap;
    }
    .status.error { color: var(--danger); background: #fff1f0; }
    .status.ok { color: var(--ok); background: #ecfdf3; }
    .code-box {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 12px;
      min-height: 68px;
      border: 1px dashed var(--line);
      border-radius: 8px;
      padding: 12px;
      margin-top: 10px;
    }
    .code {
      font-size: 32px;
      font-weight: 700;
      letter-spacing: 0;
      font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
    }
    .meta { color: var(--muted); font-size: 12px; }
    .record {
      border-top: 1px solid var(--line);
      padding: 12px 0;
    }
    .record:first-child { border-top: 0; }
    .record-title {
      display: flex;
      justify-content: space-between;
      gap: 10px;
      font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
    }
    .record-code { font-weight: 700; color: var(--brand); }
    .record-subject { margin-top: 4px; }
    .empty { color: var(--muted); padding: 16px 0; }
    @media (max-width: 820px) {
      main { grid-template-columns: 1fr; }
    }
  </style>
</head>
<body>
  <header>
    <div class="topline">
      <h1>IMAP OpenAI 验证码后台</h1>
      <a class="nav-link" href="/client" target="_blank">打开对客查询页</a>
    </div>
  </header>
  <main>
    <section>
      <h2>IMAP 邮箱配置</h2>
      <label>邮箱服务</label>
      <select id="provider">
        <option value="2925">2925 邮箱</option>
        <option value="qq">QQ 邮箱</option>
        <option value="custom">自定义 IMAP</option>
      </select>
      <label>邮箱地址</label>
      <input id="email" placeholder="name@2925.com" autocomplete="username" />
      <label>IMAP 密码/授权码</label>
      <input id="password" type="password" placeholder="2925 邮箱登录密码；如后台提供授权码则填授权码" autocomplete="current-password" />
      <div class="row">
        <div>
          <label>IMAP 主机</label>
          <input id="imapHost" value="imap.2925mail.com" />
        </div>
        <div>
          <label>端口</label>
          <input id="imapPort" value="993" inputmode="numeric" />
        </div>
      </div>
      <label>邮箱目录</label>
      <textarea id="mailboxes">INBOX</textarea>
      <div class="row">
        <div>
          <label>每目录扫描封数</label>
          <input id="maxMessages" value="80" inputmode="numeric" />
        </div>
        <div>
          <label>间隔秒</label>
          <input id="pollInterval" value="6" inputmode="numeric" />
        </div>
      </div>
      <div class="actions">
        <button id="saveBtn">保存并扫描</button>
        <button id="scanBtn" class="secondary">立即扫描</button>
      </div>
      <div id="status" class="status">正在读取状态...</div>
    </section>

    <section>
      <h2>收取邮件记录</h2>
      <label>查询邮箱</label>
      <input id="alias" placeholder="输入或粘贴 xxxx@duck.com / name@2925.com，可筛选记录" autocomplete="off" />
      <div class="actions">
        <button id="queryBtn">查询验证码</button>
        <button id="copyBtn" class="secondary">复制验证码</button>
      </div>
      <div class="code-box">
        <div>
          <div id="code" class="code">------</div>
          <div id="codeMeta" class="meta">暂无匹配记录</div>
        </div>
      </div>
      <h2 style="margin-top:18px;">最近记录</h2>
      <div id="records"></div>
    </section>
  </main>
  <script>
    const $ = (id) => document.getElementById(id);
    const providerPresets = {
      "2925": {
        label: "2925 邮箱",
        emailPlaceholder: "name@2925.com",
        passwordPlaceholder: "2925 邮箱登录密码；如后台提供授权码则填授权码",
        imap_host: "imap.2925mail.com",
        imap_port: 993,
      },
      qq: {
        label: "QQ 邮箱",
        emailPlaceholder: "name@qq.com",
        passwordPlaceholder: "QQ 邮箱 IMAP 授权码，不是 QQ 登录密码",
        imap_host: "imap.qq.com",
        imap_port: 993,
      },
      custom: {
        label: "自定义 IMAP",
        emailPlaceholder: "name@example.com",
        passwordPlaceholder: "邮箱 IMAP 密码或第三方客户端授权码",
        imap_host: "imap.2925mail.com",
        imap_port: 993,
      },
    };
    let savedProfiles = {};
    let latestCode = "";

    function setBusy(button, busy) {
      button.disabled = busy;
    }

    function setStatus(text, kind = "") {
      $("status").className = `status ${kind}`;
      $("status").textContent = text || "";
    }

    async function api(path, options = {}) {
      const res = await fetch(path, {
        ...options,
        headers: {
          "Content-Type": "application/json",
          ...(options.headers || {}),
        },
      });
      const data = await res.json();
      if (!res.ok || data.ok === false) {
        throw new Error(data.error || `HTTP ${res.status}`);
      }
      return data;
    }

    function renderState(data) {
      const cfg = data.config || {};
      savedProfiles = {};
      for (const profile of data.profiles || []) {
        if (profile.provider) savedProfiles[profile.provider] = profile;
      }
      applyConfigToForm(cfg, true);
      setStatus([
        data.last_message || "",
        data.last_scan_at ? `上次扫描：${data.last_scan_at}` : "",
        data.configured ? `当前服务：${cfg.provider_label || ""}` : "",
        data.configured ? `当前邮箱：${cfg.email || cfg.masked_email || ""}` : "尚未配置",
        data.last_error ? `错误：${data.last_error}` : "",
      ].filter(Boolean).join("\\n"), data.last_error ? "error" : (data.configured ? "ok" : ""));
      renderRecords(data.records || []);
    }

    function applyConfigToForm(config = {}, isActive = false) {
      const provider = config.provider || $("provider").value || "2925";
      const preset = providerPresets[provider] || providerPresets.custom;
      $("provider").value = provider;
      $("email").placeholder = preset.emailPlaceholder;
      $("email").value = config.email || "";
      $("password").value = "";
      $("password").placeholder = config.has_password
        ? `${preset.label}已保存密码/授权码，留空则沿用`
        : preset.passwordPlaceholder;
      $("imapHost").value = config.imap_host || preset.imap_host;
      $("imapPort").value = config.imap_port || preset.imap_port;
      if (Array.isArray(config.mailboxes)) $("mailboxes").value = config.mailboxes.join("\\n");
      if (config.max_messages) $("maxMessages").value = config.max_messages;
      if (config.poll_interval_seconds) $("pollInterval").value = config.poll_interval_seconds;
      if (!isActive && !config.email) {
        $("mailboxes").value = "INBOX";
      }
    }

    function switchProvider() {
      const provider = $("provider").value;
      const profile = savedProfiles[provider] || {
        provider,
        mailboxes: ["INBOX"],
        max_messages: $("maxMessages").value || 80,
        poll_interval_seconds: $("pollInterval").value || 6,
      };
      applyConfigToForm(profile, false);
    }

    function renderRecords(records) {
      if (!records.length) {
        $("records").innerHTML = '<div class="empty">暂无 OpenAI 验证码邮件。</div>';
        return;
      }
      $("records").innerHTML = records.slice(0, 20).map((record) => {
        const alias = record.primaryAlias || (record.aliases || []).join(", ") || "未识别邮箱";
        return `
          <div class="record">
            <div class="record-title">
              <span>${escapeHtml(alias)}</span>
              <span class="record-code">${escapeHtml(record.code || "")}</span>
            </div>
            <div class="record-subject">${escapeHtml(record.subject || "")}</div>
            <div class="meta">${escapeHtml(record.sender || "")} · ${escapeHtml(record.date || record.scannedAt || "")}</div>
          </div>
        `;
      }).join("");
    }

    function escapeHtml(text) {
      return String(text || "").replace(/[&<>"']/g, (ch) => ({
        "&": "&amp;",
        "<": "&lt;",
        ">": "&gt;",
        '"': "&quot;",
        "'": "&#39;",
      }[ch]));
    }

    async function refreshStatus() {
      const data = await api("/api/status");
      renderState(data);
    }

    async function saveConfig() {
      setBusy($("saveBtn"), true);
      try {
        const data = await api("/api/config", {
          method: "POST",
          body: JSON.stringify({
            provider: $("provider").value,
            email: $("email").value,
            password: $("password").value,
            imap_host: $("imapHost").value,
            imap_port: $("imapPort").value,
            mailboxes: $("mailboxes").value,
            max_messages: $("maxMessages").value,
            poll_interval_seconds: $("pollInterval").value,
          }),
        });
        renderState(data);
      } catch (err) {
        setStatus(err.message, "error");
      } finally {
        setBusy($("saveBtn"), false);
      }
    }

    async function scanNow() {
      setBusy($("scanBtn"), true);
      try {
        const data = await api("/api/scan", { method: "POST", body: "{}" });
        renderState(data);
      } catch (err) {
        setStatus(err.message, "error");
      } finally {
        setBusy($("scanBtn"), false);
      }
    }

    async function queryCode() {
      setBusy($("queryBtn"), true);
      try {
        const alias = encodeURIComponent($("alias").value.trim());
        const data = await api(`/api/records?q=${alias}`);
        const records = data.records || [];
        const record = records[0];
        latestCode = record?.code || "";
        $("code").textContent = latestCode || "------";
        $("codeMeta").textContent = record
          ? `${record.primaryAlias || "未识别邮箱"} · ${record.subject || ""}`
          : "暂无匹配记录";
        renderRecords(records);
      } catch (err) {
        $("code").textContent = "------";
        $("codeMeta").textContent = err.message;
      } finally {
        setBusy($("queryBtn"), false);
      }
    }

    async function copyCode() {
      if (!latestCode) return;
      await navigator.clipboard.writeText(latestCode);
      $("codeMeta").textContent = `已复制验证码 ${latestCode}`;
    }

    $("saveBtn").addEventListener("click", saveConfig);
    $("scanBtn").addEventListener("click", scanNow);
    $("queryBtn").addEventListener("click", queryCode);
    $("copyBtn").addEventListener("click", copyCode);
    $("provider").addEventListener("change", switchProvider);
    $("alias").addEventListener("keydown", (event) => {
      if (event.key === "Enter") queryCode();
    });

    refreshStatus().catch((err) => setStatus(err.message, "error"));
    setInterval(() => {
      refreshStatus().catch(() => {});
    }, 5000);
  </script>
</body>
</html>"""


CLIENT_PAGE_HTML = r"""<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>GPT小店验证码查询</title>
  <style>
    :root {
      color-scheme: light;
      --paper: #fbfaf7;
      --ink: #111827;
      --soft: #f0eee8;
      --line: #d7d0c4;
      --muted: #6b665d;
      --accent: #0f766e;
      --accent-deep: #115e59;
      --amber: #a15c10;
      --danger: #b42318;
      --panel: rgba(255, 255, 255, .84);
    }
    * { box-sizing: border-box; }
    body {
      margin: 0;
      min-height: 100vh;
      color: var(--ink);
      font: 15px/1.55 Georgia, "Times New Roman", "Songti SC", serif;
      background:
        linear-gradient(90deg, rgba(17,24,39,.035) 1px, transparent 1px),
        linear-gradient(180deg, rgba(17,24,39,.03) 1px, transparent 1px),
        var(--paper);
      background-size: 34px 34px;
    }
    .shell {
      width: min(1360px, calc(100vw - 32px));
      margin: 0 auto;
      padding: 34px 0 46px;
    }
    .masthead {
      display: grid;
      grid-template-columns: minmax(0, 1fr) auto;
      gap: 24px;
      align-items: end;
      padding-bottom: 18px;
      border-bottom: 2px solid var(--ink);
    }
    .eyebrow {
      margin: 0 0 8px;
      color: var(--accent-deep);
      font: 700 12px/1.2 ui-monospace, SFMono-Regular, Menlo, monospace;
      text-transform: uppercase;
    }
    h1 {
      margin: 0;
      font-size: 58px;
      line-height: .96;
      font-weight: 700;
      letter-spacing: 0;
    }
    h2 {
      margin: 0;
      font-size: 20px;
      letter-spacing: 0;
    }
    .stamp {
      min-width: 142px;
      border: 2px solid var(--ink);
      padding: 12px;
      text-align: center;
      transform: rotate(-2deg);
      background: var(--panel);
      box-shadow: 8px 8px 0 var(--soft);
      font: 700 13px/1.35 ui-monospace, SFMono-Regular, Menlo, monospace;
    }
    .intro-card {
      margin-top: 18px;
      display: grid;
      grid-template-columns: minmax(0, 1fr) auto;
      gap: 16px;
      align-items: center;
      border: 1px solid var(--line);
      background: rgba(255, 255, 255, .68);
      padding: 14px 16px;
    }
    .intro-title {
      margin: 0 0 5px;
      color: var(--accent-deep);
      font: 800 14px/1.3 ui-monospace, SFMono-Regular, Menlo, monospace;
    }
    .intro-text {
      margin: 0;
      color: var(--ink);
      font-size: 15px;
    }
    .shop-link {
      border: 1px solid var(--ink);
      background: #fff;
      color: var(--ink);
      padding: 10px 12px;
      text-decoration: none;
      font: 800 13px/1 ui-monospace, SFMono-Regular, Menlo, monospace;
      white-space: nowrap;
    }
    .shop-link:hover {
      transform: translateY(-1px);
    }
    .import-panel {
      margin-top: 24px;
      border: 2px solid var(--ink);
      background: var(--panel);
      box-shadow: 12px 12px 0 var(--soft);
      padding: 16px;
    }
    label {
      display: block;
      margin: 0 0 9px;
      color: var(--muted);
      font: 700 12px/1.2 ui-monospace, SFMono-Regular, Menlo, monospace;
    }
    textarea, input {
      width: 100%;
      border: 1px solid var(--line);
      border-radius: 0;
      padding: 12px 13px;
      background: #fff;
      color: var(--ink);
      font: 15px/1.45 ui-monospace, SFMono-Regular, Menlo, monospace;
      outline: none;
    }
    textarea {
      min-height: 88px;
      resize: vertical;
    }
    textarea:focus, input:focus {
      border-color: var(--accent);
      box-shadow: inset 0 -3px 0 rgba(15, 118, 110, .18);
    }
    button {
      border: 1px solid var(--ink);
      border-radius: 0;
      padding: 0 14px;
      background: var(--ink);
      color: #fff;
      font: 700 13px/1 ui-monospace, SFMono-Regular, Menlo, monospace;
      cursor: pointer;
      min-height: 44px;
      white-space: nowrap;
    }
    button.secondary {
      background: #fff;
      color: var(--ink);
    }
    button.danger {
      background: #fff;
      border-color: var(--danger);
      color: var(--danger);
    }
    button.small {
      min-height: 32px;
      padding: 0 9px;
      font-size: 12px;
    }
    button:hover {
      transform: translateY(-1px);
    }
    button:disabled {
      opacity: .55;
      cursor: wait;
      transform: none;
    }
    .import-actions {
      display: flex;
      gap: 10px;
      align-items: center;
      justify-content: space-between;
      margin-top: 10px;
      flex-wrap: wrap;
    }
    .hint, .meta {
      color: var(--muted);
      font-size: 13px;
    }
    .workspace {
      display: grid;
      grid-template-columns: 380px minmax(0, 1fr);
      gap: 18px;
      margin-top: 26px;
      align-items: start;
    }
    .pane {
      border-top: 2px solid var(--ink);
      padding-top: 12px;
      min-width: 0;
    }
    .pane-head {
      display: flex;
      justify-content: space-between;
      gap: 12px;
      align-items: center;
      margin-bottom: 12px;
    }
    .count {
      color: var(--accent-deep);
      font: 700 13px/1.2 ui-monospace, SFMono-Regular, Menlo, monospace;
    }
    .account-tools {
      display: grid;
      grid-template-columns: minmax(0, 1fr) auto;
      gap: 8px;
      margin-bottom: 10px;
    }
    .account-list {
      display: grid;
      gap: 8px;
      max-height: 62vh;
      overflow: auto;
      padding-right: 4px;
    }
    .account {
      width: 100%;
      display: grid;
      grid-template-columns: minmax(0, 1fr) auto;
      gap: 10px;
      align-items: center;
      border: 1px solid var(--line);
      background: rgba(255,255,255,.72);
      padding: 11px;
      text-align: left;
    }
    .account.active {
      border-color: var(--ink);
      box-shadow: inset 4px 0 0 var(--accent);
      background: #fff;
    }
    .account-main {
      min-width: 0;
      width: 100%;
      min-height: auto;
      border: 0;
      background: transparent;
      color: var(--ink);
      padding: 0;
      text-align: left;
    }
    .account-email {
      font: 800 13px/1.35 ui-monospace, SFMono-Regular, Menlo, monospace;
      overflow-wrap: anywhere;
    }
    .account-pass {
      margin-top: 4px;
      color: var(--muted);
      font: 13px/1.35 ui-monospace, SFMono-Regular, Menlo, monospace;
      overflow-wrap: anywhere;
    }
    .account-actions {
      display: flex;
      flex-direction: column;
      gap: 6px;
    }
    .query-bar {
      display: grid;
      grid-template-columns: minmax(0, 1fr) auto auto auto;
      gap: 8px;
      margin-bottom: 12px;
    }
    .selected-account {
      display: grid;
      grid-template-columns: minmax(0, 1fr) auto;
      gap: 10px;
      align-items: center;
      border: 1px solid var(--line);
      background: rgba(255,255,255,.62);
      padding: 12px;
      margin-bottom: 12px;
    }
    .selected-title {
      font: 800 15px/1.35 ui-monospace, SFMono-Regular, Menlo, monospace;
      overflow-wrap: anywhere;
    }
    .selected-pass {
      margin-top: 4px;
      color: var(--amber);
      font: 700 13px/1.35 ui-monospace, SFMono-Regular, Menlo, monospace;
      overflow-wrap: anywhere;
    }
    .selected-actions {
      display: flex;
      gap: 8px;
      flex-wrap: wrap;
      justify-content: flex-end;
    }
    .result-head {
      display: flex;
      justify-content: space-between;
      gap: 12px;
      align-items: center;
      margin: 12px 0;
      border-bottom: 1px solid var(--line);
      padding-bottom: 8px;
    }
    .status {
      color: var(--muted);
      font: 13px/1.4 ui-monospace, SFMono-Regular, Menlo, monospace;
      text-align: right;
    }
    .status.error {
      color: var(--danger);
    }
    .records {
      display: grid;
      gap: 12px;
    }
    .record {
      display: grid;
      grid-template-columns: 118px minmax(0, 1fr) auto;
      gap: 14px;
      align-items: center;
      border: 1px solid var(--line);
      background: rgba(255,255,255,.72);
      padding: 14px;
    }
    .code {
      font: 800 30px/1 ui-monospace, SFMono-Regular, Menlo, monospace;
      color: var(--accent-deep);
    }
    .mail {
      min-width: 0;
    }
    .alias {
      font: 700 14px/1.3 ui-monospace, SFMono-Regular, Menlo, monospace;
      overflow-wrap: anywhere;
    }
    .subject {
      margin-top: 4px;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }
    .copy-group {
      display: flex;
      flex-direction: column;
      gap: 8px;
    }
    .empty {
      border: 1px dashed var(--line);
      padding: 32px 18px;
      text-align: center;
      color: var(--muted);
      background: rgba(255,255,255,.55);
    }
    .toast {
      position: fixed;
      left: 50%;
      bottom: 22px;
      transform: translateX(-50%);
      background: var(--ink);
      color: #fff;
      padding: 10px 14px;
      opacity: 0;
      pointer-events: none;
      transition: opacity .18s ease, transform .18s ease;
      font: 13px/1.3 ui-monospace, SFMono-Regular, Menlo, monospace;
      z-index: 20;
    }
    .toast.show {
      opacity: 1;
      transform: translateX(-50%) translateY(-4px);
    }
    @media (max-width: 980px) {
      h1 { font-size: 42px; }
      .workspace { grid-template-columns: 1fr; }
      .account-list { max-height: none; }
    }
    @media (max-width: 720px) {
      .shell { width: min(100% - 24px, 1360px); padding-top: 26px; }
      .masthead { grid-template-columns: 1fr; }
      .intro-card { grid-template-columns: 1fr; }
      .stamp { width: max-content; }
      .query-bar, .account-tools { grid-template-columns: 1fr; }
      button { width: 100%; }
      .selected-account, .record, .account { grid-template-columns: 1fr; }
      .selected-actions, .copy-group, .account-actions { flex-direction: row; justify-content: flex-start; }
      .subject { white-space: normal; }
    }
  </style>
</head>
<body>
  <div class="shell">
    <header class="masthead">
      <div>
        <p class="eyebrow">GPT Shop Code Desk</p>
        <h1>GPT小店验证码查询</h1>
      </div>
      <div class="stamp">
        GPT-猛蹬小店
      </div>
    </header>

    <section class="intro-card">
      <div>
        <p class="intro-title">使用说明</p>
        <p class="intro-text">获取到的邮箱可在此处查询 GPT 登陆验证码，请保存此站避免无法登陆。</p>
      </div>
      <a class="shop-link" href="https://xxx.com" target="_blank" rel="noreferrer">小店链接：xxx.com</a>
    </section>

    <section class="import-panel">
      <label for="accountInput">粘贴账号</label>
      <textarea id="accountInput" placeholder="violin-dime-blot@duck.com-----1q@W#E¥R"></textarea>
      <div class="import-actions">
        <div class="hint">支持一行一个，也支持只粘贴邮箱。</div>
        <div>
          <button id="saveAccountsBtn" type="button">保存账号</button>
          <button id="pasteAccountsBtn" class="secondary" type="button">粘贴并保存</button>
        </div>
      </div>
    </section>

    <main class="workspace">
      <aside class="pane">
        <div class="pane-head">
          <h2>账号列表</h2>
          <span class="count" id="accountCount">0 个账号</span>
        </div>
        <div class="account-tools">
          <input id="accountFilter" placeholder="筛选邮箱或密码" autocomplete="off" />
          <button id="clearAccountsBtn" class="danger" type="button">清空</button>
        </div>
        <div class="account-list" id="accountList">
          <div class="empty">暂无账号。</div>
        </div>
      </aside>

      <section class="pane">
        <div class="query-bar">
          <input id="queryInput" placeholder="example@duck.com 或 name@2925.com" autocomplete="off" />
          <button id="queryBtn" type="button">查询</button>
          <button id="pasteQueryBtn" class="secondary" type="button">粘贴</button>
          <button id="refreshBtn" class="secondary" type="button">刷新</button>
        </div>

        <div class="selected-account" id="selectedAccount">
          <div>
            <div class="selected-title">未选择账号</div>
            <div class="meta">从左侧选择账号，或直接输入邮箱查询。</div>
          </div>
        </div>

        <div class="result-head">
          <h2>信件列表</h2>
          <div class="status" id="status">等待查询</div>
        </div>
        <div class="records" id="records">
          <div class="empty">选择账号后会显示对应的 GPT 登陆验证码邮件。</div>
        </div>
      </section>
    </main>
  </div>
  <div class="toast" id="toast">已复制</div>

  <script>
    const $ = (id) => document.getElementById(id);
    const accountStorageKey = "qqOpenaiClientAccounts:v1";
    const emailPattern = /[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/i;
    const emailGlobalPattern = /[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/ig;
    let accounts = [];
    let selectedEmail = "";
    let lastRecords = [];

    function escapeHtml(text) {
      return String(text || "").replace(/[&<>"']/g, (ch) => ({
        "&": "&amp;",
        "<": "&lt;",
        ">": "&gt;",
        '"': "&quot;",
        "'": "&#39;",
      }[ch]));
    }

    function extractEmail(text) {
      const match = String(text || "").match(emailPattern);
      return (match ? match[0] : String(text || "")).trim().toLowerCase();
    }

    function isEmail(text) {
      return emailPattern.test(String(text || "").trim());
    }

    function normalizePassword(text) {
      return String(text || "").trim();
    }

    function parseAccountEntries(text) {
      const entries = [];
      const seen = new Set();
      for (const rawLine of String(text || "").split(/\r?\n/)) {
        const line = rawLine.trim();
        if (!line) continue;
        const email = extractEmail(line);
        if (!isEmail(email)) continue;
        const emailIndex = line.toLowerCase().indexOf(email);
        const tail = emailIndex >= 0 ? line.slice(emailIndex + email.length) : "";
        const delimiterIndex = tail.indexOf("-----");
        const password = delimiterIndex >= 0 ? normalizePassword(tail.slice(delimiterIndex + 5)) : "";
        if (!seen.has(email)) {
          seen.add(email);
          entries.push({ email, password, updatedAt: Date.now() });
        }
      }
      if (!entries.length) {
        for (const email of String(text || "").match(emailGlobalPattern) || []) {
          const normalized = email.toLowerCase();
          if (!seen.has(normalized)) {
            seen.add(normalized);
            entries.push({ email: normalized, password: "", updatedAt: Date.now() });
          }
        }
      }
      return entries;
    }

    function loadAccounts() {
      try {
        const raw = localStorage.getItem(accountStorageKey);
        const parsed = raw ? JSON.parse(raw) : [];
        accounts = Array.isArray(parsed)
          ? parsed.filter((item) => item && item.email).map((item) => ({
              email: extractEmail(item.email),
              password: normalizePassword(item.password),
              updatedAt: Number(item.updatedAt || Date.now()),
            }))
          : [];
      } catch {
        accounts = [];
      }
    }

    function saveAccounts() {
      localStorage.setItem(accountStorageKey, JSON.stringify(accounts));
    }

    function upsertAccounts(entries) {
      let changed = 0;
      for (const entry of entries) {
        const email = extractEmail(entry.email);
        if (!isEmail(email)) continue;
        const index = accounts.findIndex((item) => item.email === email);
        const next = {
          email,
          password: normalizePassword(entry.password),
          updatedAt: Date.now(),
        };
        if (index >= 0) {
          accounts[index] = { ...accounts[index], ...next };
        } else {
          accounts.unshift(next);
        }
        changed += 1;
      }
      accounts.sort((a, b) => Number(b.updatedAt || 0) - Number(a.updatedAt || 0));
      saveAccounts();
      renderAccounts();
      return changed;
    }

    function findAccount(email) {
      return accounts.find((item) => item.email === email) || null;
    }

    function maskPassword(password) {
      const text = normalizePassword(password);
      if (!text) return "未记录密码";
      if (text.length <= 4) return "*".repeat(text.length);
      return `${text.slice(0, 2)}${"*".repeat(Math.min(8, text.length - 4))}${text.slice(-2)}`;
    }

    function formatAccountLine(account) {
      return account.password ? `${account.email}-----${account.password}` : account.email;
    }

    function renderAccounts() {
      const filter = $("accountFilter").value.trim().toLowerCase();
      const visible = accounts.filter((account) => {
        const source = `${account.email}\n${account.password}`.toLowerCase();
        return !filter || source.includes(filter);
      });
      $("accountCount").textContent = `${accounts.length} 个账号`;
      if (!visible.length) {
        $("accountList").innerHTML = `<div class="empty">${accounts.length ? "没有匹配账号。" : "暂无账号。"}</div>`;
        return;
      }
      $("accountList").innerHTML = visible.map((account) => `
        <div class="account ${account.email === selectedEmail ? "active" : ""}" data-account="${escapeHtml(account.email)}">
          <button class="account-main secondary" type="button" data-select="${escapeHtml(account.email)}">
            <div class="account-email">${escapeHtml(account.email)}</div>
            <div class="account-pass">${escapeHtml(maskPassword(account.password))}</div>
          </button>
          <div class="account-actions">
            <button class="small secondary" type="button" data-copy-account="${escapeHtml(account.email)}">复制</button>
            <button class="small danger" type="button" data-delete="${escapeHtml(account.email)}">删除</button>
          </div>
        </div>
      `).join("");
      $("accountList").querySelectorAll("[data-select]").forEach((button) => {
        button.addEventListener("click", () => selectAccount(button.dataset.select || ""));
      });
      $("accountList").querySelectorAll("[data-copy-account]").forEach((button) => {
        button.addEventListener("click", () => {
          const account = findAccount(button.dataset.copyAccount || "");
          if (account) copyText(formatAccountLine(account));
        });
      });
      $("accountList").querySelectorAll("[data-delete]").forEach((button) => {
        button.addEventListener("click", () => deleteAccount(button.dataset.delete || ""));
      });
    }

    function renderSelectedAccount() {
      const account = findAccount(selectedEmail);
      if (!account) {
        $("selectedAccount").innerHTML = `
          <div>
            <div class="selected-title">${selectedEmail ? escapeHtml(selectedEmail) : "未选择账号"}</div>
            <div class="meta">${selectedEmail ? "当前邮箱未保存到账号列表。" : "从左侧选择账号，或直接输入邮箱查询。"}</div>
          </div>
        `;
        return;
      }
      $("selectedAccount").innerHTML = `
        <div>
          <div class="selected-title">${escapeHtml(account.email)}</div>
          <div class="selected-pass">${escapeHtml(maskPassword(account.password))}</div>
        </div>
        <div class="selected-actions">
          <button class="small secondary" type="button" id="copyEmailBtn">复制邮箱</button>
          <button class="small secondary" type="button" id="copyPasswordBtn">复制密码</button>
          <button class="small" type="button" id="copyAccountBtn">复制整条</button>
        </div>
      `;
      $("copyEmailBtn").addEventListener("click", () => copyText(account.email));
      $("copyPasswordBtn").addEventListener("click", () => copyText(account.password));
      $("copyAccountBtn").addEventListener("click", () => copyText(formatAccountLine(account)));
    }

    function formatTime(record) {
      const raw = record.date || record.scannedAt || "";
      const parsed = raw ? new Date(raw) : null;
      if (!parsed || Number.isNaN(parsed.getTime())) return raw || "未知时间";
      return parsed.toLocaleString();
    }

    async function api(path) {
      const response = await fetch(path);
      const data = await response.json();
      if (!response.ok || data.ok === false) {
        throw new Error(data.error || `HTTP ${response.status}`);
      }
      return data;
    }

    function setStatus(text, isError = false) {
      $("status").textContent = text;
      $("status").className = `status${isError ? " error" : ""}`;
    }

    function renderRecords(records, query) {
      lastRecords = records || [];
      if (!lastRecords.length) {
        $("records").innerHTML = `<div class="empty">没有查到 ${escapeHtml(query || "该邮箱")} 的验证码邮件。请稍后刷新重试。</div>`;
        return;
      }
      $("records").innerHTML = lastRecords.map((record, index) => {
        const alias = record.primaryAlias || (record.aliases || []).join(", ") || query || "未识别邮箱";
        return `
          <article class="record">
            <div class="code">${escapeHtml(record.code || "------")}</div>
            <div class="mail">
              <div class="alias">${escapeHtml(alias)}</div>
              <div class="subject">${escapeHtml(record.subject || "无主题")}</div>
              <div class="meta">${escapeHtml(record.sender || "未知发件人")} · ${escapeHtml(formatTime(record))}</div>
            </div>
            <div class="copy-group">
              <button class="small" type="button" data-copy-code="${index}">复制验证码</button>
              <button class="small secondary" type="button" data-copy-full="${index}">复制整条</button>
            </div>
          </article>
        `;
      }).join("");
      $("records").querySelectorAll("[data-copy-code]").forEach((button) => {
        button.addEventListener("click", () => copyText(lastRecords[Number(button.dataset.copyCode)]?.code || ""));
      });
      $("records").querySelectorAll("[data-copy-full]").forEach((button) => {
        button.addEventListener("click", () => {
          const record = lastRecords[Number(button.dataset.copyFull)] || {};
          const account = findAccount(selectedEmail);
          const alias = record.primaryAlias || (record.aliases || []).join(", ") || query || "";
          const passwordLine = account?.password ? `\n密码：${account.password}` : "";
          copyText(`${alias}${passwordLine}\n验证码：${record.code || ""}\n${record.subject || ""}`);
        });
      });
    }

    async function queryRecords(email = "") {
      const query = extractEmail(email || $("queryInput").value);
      $("queryInput").value = query;
      selectedEmail = query;
      renderSelectedAccount();
      renderAccounts();
      if (!query) {
        setStatus("请输入邮箱", true);
        return;
      }
      $("queryBtn").disabled = true;
      $("refreshBtn").disabled = true;
      try {
        const data = await api(`/api/records?q=${encodeURIComponent(query)}`);
        renderRecords(data.records || [], query);
        setStatus(`查到 ${(data.records || []).length} 封相关邮件`);
        if ((data.records || []).length === 1 && data.records[0].code) {
          await copyText(data.records[0].code, false);
          setStatus("查到 1 封邮件，验证码已自动复制");
        }
      } catch (error) {
        setStatus(error.message, true);
      } finally {
        $("queryBtn").disabled = false;
        $("refreshBtn").disabled = false;
      }
    }

    function selectAccount(email) {
      selectedEmail = extractEmail(email);
      $("queryInput").value = selectedEmail;
      renderSelectedAccount();
      renderAccounts();
      queryRecords(selectedEmail);
    }

    function deleteAccount(email) {
      const target = extractEmail(email);
      accounts = accounts.filter((account) => account.email !== target);
      if (selectedEmail === target) selectedEmail = "";
      saveAccounts();
      renderAccounts();
      renderSelectedAccount();
      if (!selectedEmail) {
        $("queryInput").value = "";
        $("records").innerHTML = '<div class="empty">选择账号后会显示对应的 GPT 登陆验证码邮件。</div>';
        setStatus("等待查询");
      }
    }

    function importFromText(text, shouldQueryFirst = true) {
      const entries = parseAccountEntries(text);
      if (!entries.length) {
        showToast("没有识别到邮箱");
        return;
      }
      const changed = upsertAccounts(entries);
      $("accountInput").value = "";
      showToast(`已保存 ${changed} 个账号`);
      if (shouldQueryFirst) selectAccount(entries[0].email);
    }

    async function copyText(text, show = true) {
      const value = String(text || "").trim();
      if (!value) return;
      await navigator.clipboard.writeText(value);
      if (show) showToast("已复制");
    }

    function showToast(text) {
      const toast = $("toast");
      toast.textContent = text;
      toast.classList.add("show");
      clearTimeout(showToast.timer);
      showToast.timer = setTimeout(() => toast.classList.remove("show"), 1400);
    }

    async function pasteAccounts() {
      try {
        const text = await navigator.clipboard.readText();
        $("accountInput").value = text;
        importFromText(text);
      } catch (error) {
        setStatus(`读取剪贴板失败：${error.message}`, true);
      }
    }

    async function pasteQuery() {
      try {
        const text = await navigator.clipboard.readText();
        const entries = parseAccountEntries(text);
        if (entries.length) {
          upsertAccounts(entries);
          selectAccount(entries[0].email);
          return;
        }
        $("queryInput").value = extractEmail(text);
        await queryRecords();
      } catch (error) {
        setStatus(`读取剪贴板失败：${error.message}`, true);
      }
    }

    $("saveAccountsBtn").addEventListener("click", () => importFromText($("accountInput").value));
    $("pasteAccountsBtn").addEventListener("click", pasteAccounts);
    $("clearAccountsBtn").addEventListener("click", () => {
      accounts = [];
      selectedEmail = "";
      saveAccounts();
      renderAccounts();
      renderSelectedAccount();
      $("queryInput").value = "";
      $("records").innerHTML = '<div class="empty">选择账号后会显示对应的 GPT 登陆验证码邮件。</div>';
      setStatus("账号列表已清空");
    });
    $("accountFilter").addEventListener("input", renderAccounts);
    $("queryBtn").addEventListener("click", () => queryRecords());
    $("refreshBtn").addEventListener("click", () => queryRecords(selectedEmail || $("queryInput").value));
    $("pasteQueryBtn").addEventListener("click", pasteQuery);
    $("queryInput").addEventListener("paste", () => {
      setTimeout(() => {
        const value = $("queryInput").value;
        const entries = parseAccountEntries(value);
        if (entries.length) {
          upsertAccounts(entries);
          selectAccount(entries[0].email);
        } else {
          $("queryInput").value = extractEmail(value);
          queryRecords();
        }
      }, 0);
    });
    $("accountInput").addEventListener("paste", () => {
      setTimeout(() => {
        const entries = parseAccountEntries($("accountInput").value);
        if (entries.length) {
          upsertAccounts(entries);
          showToast(`已保存 ${entries.length} 个账号`);
        }
      }, 0);
    });
    $("queryInput").addEventListener("keydown", (event) => {
      if (event.key === "Enter") queryRecords();
    });

    loadAccounts();
    renderAccounts();
    renderSelectedAccount();
    api("/api/status")
      .then((data) => setStatus(data.configured ? "验证码服务已连接" : "验证码服务暂未配置", !data.configured))
      .catch((error) => setStatus(error.message, true));
  </script>
</body>
</html>"""


def start_monitor_thread() -> None:
    thread = threading.Thread(target=monitor_loop, name="imap-openai-code-monitor", daemon=True)
    thread.start()


def apply_env_config() -> None:
    imap_email = (
        os.environ.get("IMAP_OPENAI_HELPER_EMAIL")
        or os.environ.get("QQ_OPENAI_HELPER_EMAIL")
        or ""
    ).strip()
    password = (
        os.environ.get("IMAP_OPENAI_HELPER_PASSWORD")
        or os.environ.get("QQ_OPENAI_HELPER_PASSWORD")
        or ""
    ).strip()
    if not imap_email or not password:
        return
    provider = (
        os.environ.get("IMAP_OPENAI_HELPER_PROVIDER")
        or os.environ.get("QQ_OPENAI_HELPER_PROVIDER")
        or ""
    )
    apply_config({
        "provider": provider or infer_provider({
            "email": imap_email,
            "imap_host": os.environ.get("IMAP_OPENAI_HELPER_IMAP_HOST") or os.environ.get("QQ_OPENAI_HELPER_IMAP_HOST"),
        }),
        "email": imap_email,
        "password": password,
        "imap_host": (
            os.environ.get("IMAP_OPENAI_HELPER_IMAP_HOST")
            or os.environ.get("QQ_OPENAI_HELPER_IMAP_HOST")
            or DEFAULT_IMAP_HOST
        ),
        "imap_port": (
            os.environ.get("IMAP_OPENAI_HELPER_IMAP_PORT")
            or os.environ.get("QQ_OPENAI_HELPER_IMAP_PORT")
            or DEFAULT_IMAP_PORT
        ),
        "mailboxes": (
            os.environ.get("IMAP_OPENAI_HELPER_MAILBOXES")
            or os.environ.get("QQ_OPENAI_HELPER_MAILBOXES")
            or "INBOX"
        ),
        "max_messages": (
            os.environ.get("IMAP_OPENAI_HELPER_MAX_MESSAGES")
            or os.environ.get("QQ_OPENAI_HELPER_MAX_MESSAGES")
            or DEFAULT_MAX_MESSAGES
        ),
        "poll_interval_seconds": (
            os.environ.get("IMAP_OPENAI_HELPER_POLL_INTERVAL_SECONDS")
            or os.environ.get("QQ_OPENAI_HELPER_POLL_INTERVAL_SECONDS")
            or DEFAULT_POLL_INTERVAL_SECONDS
        ),
    })


def main() -> None:
    parser = argparse.ArgumentParser(description="IMAP 邮箱 OpenAI 验证码本地查询页面")
    parser.add_argument("--host", default=HOST)
    parser.add_argument("--port", type=int, default=PORT)
    parser.add_argument("--open", action="store_true", help="启动后自动打开浏览器页面")
    args = parser.parse_args()

    socket.setdefaulttimeout(35)
    init_database()
    load_persisted_config()
    apply_env_config()
    start_monitor_thread()

    server = ThreadingHTTPServer((args.host, args.port), HelperHandler)
    url = f"http://{args.host}:{args.port}/"
    print(f"[IMAPCodeHelper] listening on {url}", flush=True)
    print(f"[IMAPCodeHelper] 数据库路径：{get_db_path()}", flush=True)
    print("[IMAPCodeHelper] IMAP 密码/授权码和邮件记录会写入本地数据库，用于重启后继续扫描。", flush=True)
    if args.open:
        webbrowser.open(url)
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        print("\n[IMAPCodeHelper] stopping", flush=True)
    finally:
        STOP_EVENT.set()
        server.server_close()


if __name__ == "__main__":
    main()
