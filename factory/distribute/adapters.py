"""Platform adapters — one class per platform, official APIs only.

Security notes baked in:
* Every adapter reads credentials from the environment at call time.
* The Discord webhook adapter ALWAYS sends a browser User-Agent (Cloudflare in
  front of Discord webhooks 403s urllib's default agent — learned the hard way).
* No payload ever contains a credential; error strings are truncated.
"""

from __future__ import annotations

import json
import os
import urllib.parse
import urllib.request
from typing import Any

from ..utils import DEFAULT_UA, http_post_json
from .base import Adapter


class TelegramAdapter(Adapter):
    name = "telegram"
    env_required = ("TELEGRAM_BOT_TOKEN", "TELEGRAM_CHAT_ID")

    def post(self, payload: dict[str, Any]) -> dict[str, Any]:
        token = os.environ["TELEGRAM_BOT_TOKEN"]
        chat = os.environ["TELEGRAM_CHAT_ID"]
        text = str(payload.get("text", ""))[:3800]
        url = f"https://api.telegram.org/bot{token}/sendMessage"
        try:
            data = http_post_json(url, {"chat_id": chat, "text": text,
                                        "parse_mode": "HTML", "disable_web_page_preview": False},
                                  timeout=30, retries=1)
            if data.get("ok"):
                mid = (data.get("result") or {}).get("message_id")
                return {"ok": True, "id": str(mid), "error": None}
            return {"ok": False, "id": None, "error": str(data.get("description", "unknown"))[:200]}
        except Exception as e:  # noqa: BLE001
            return {"ok": False, "id": None, "error": str(e)[:200]}


class DevToAdapter(Adapter):
    name = "devto"
    env_required = ("DEVTO_API_KEY",)

    def post(self, payload: dict[str, Any]) -> dict[str, Any]:
        key = os.environ["DEVTO_API_KEY"]
        article = payload.get("article", {})
        body = {
            "article": {
                "title": str(article.get("title", "New tool from the Product Factory"))[:128],
                "published": True,
                "body_markdown": str(payload.get("body_markdown", ""))[:8000],
                "tags": [t for t in article.get("tags", ["showdev"]) if t.isalnum()][:4],
                "description": str(article.get("description", ""))[:196],
            }
        }
        try:
            data = http_post_json(
                "https://dev.to/api/articles", body,
                headers={"api-key": key}, timeout=30, retries=1,
            )
            url = data.get("url")
            if url:
                return {"ok": True, "id": data.get("id"), "error": None, "url": url}
            return {"ok": False, "id": None, "error": str(data)[:200]}
        except Exception as e:  # noqa: BLE001
            return {"ok": False, "id": None, "error": str(e)[:200]}


class DiscordAdapter(Adapter):
    name = "discord"
    env_required = ("DISCORD_WEBHOOK_URL",)

    def post(self, payload: dict[str, Any]) -> dict[str, Any]:
        url = os.environ["DISCORD_WEBHOOK_URL"]
        body = {"content": str(payload.get("text", ""))[:1900]}
        try:
            data = http_post_json(url, body, headers={"User-Agent": DEFAULT_UA}, timeout=30, retries=1)
            return {"ok": True, "id": None, "error": None}
        except Exception as e:  # noqa: BLE001
            return {"ok": False, "id": None, "error": str(e)[:200]}


class BlueskyAdapter(Adapter):
    name = "bluesky"
    env_required = ("BLUESKY_HANDLE", "BLUESKY_APP_PASSWORD")

    def _session(self) -> dict[str, Any]:
        data = http_post_json(
            "https://bsky.social/xrpc/com.atproto.server.createSession",
            {"identifier": os.environ["BLUESKY_HANDLE"],
             "password": os.environ["BLUESKY_APP_PASSWORD"]},
            timeout=30, retries=1,
        )
        return data

    def check(self) -> dict[str, Any]:
        if not self.configured():
            return {"api_available": False, "note": "credentials missing"}
        try:
            self._session()
            return {"api_available": True, "note": "session ok"}
        except Exception:  # noqa: BLE001
            return {"api_available": False, "note": "session failed — check handle/password"}

    def post(self, payload: dict[str, Any]) -> dict[str, Any]:
        text = str(payload.get("text", ""))[:280]
        session = self._session()
        access = session["accessJwt"]
        did = session["did"]
        record = {
            "repo": did,
            "collection": "app.bsky.feed.post",
            "record": {"text": text, "createdAt": __import__("datetime").datetime.now(
                __import__("datetime").timezone.utc).isoformat()},
        }
        try:
            data = http_post_json(
                "https://bsky.social/xrpc/com.atproto.repo.createRecord", record,
                headers={"Authorization": f"Bearer {access}"}, timeout=30, retries=1,
            )
            uri = data.get("uri")
            return {"ok": bool(uri), "id": uri, "error": None if uri else str(data)[:200]}
        except Exception as e:  # noqa: BLE001
            return {"ok": False, "id": None, "error": str(e)[:200]}


class MastodonAdapter(Adapter):
    name = "mastodon"
    env_required = ("MASTODON_INSTANCE", "MASTODON_ACCESS_TOKEN")

    def post(self, payload: dict[str, Any]) -> dict[str, Any]:
        instance = os.environ["MASTODON_INSTANCE"].rstrip("/")
        token = os.environ["MASTODON_ACCESS_TOKEN"]
        status = str(payload.get("text", ""))[:480]
        body = urllib.parse.urlencode({"status": status}).encode()
        req = urllib.request.Request(
            f"{instance}/api/v1/statuses", data=body,
            headers={"Authorization": f"Bearer {token}", "User-Agent": DEFAULT_UA,
                     "Content-Type": "application/x-www-form-urlencoded"},
            method="POST",
        )
        try:
            with urllib.request.urlopen(req, timeout=30) as resp:
                data = json.loads(resp.read())
            return {"ok": True, "id": data.get("id"), "error": None, "url": data.get("url")}
        except Exception as e:  # noqa: BLE001
            return {"ok": False, "id": None, "error": str(e)[:200]}


class RedditAdapter(Adapter):
    name = "reddit"
    env_required = ("REDDIT_CLIENT_ID", "REDDIT_CLIENT_SECRET", "REDDIT_USERNAME", "REDDIT_PASSWORD")

    def _token(self) -> str:
        auth = urllib.parse.quote(os.environ["REDDIT_CLIENT_ID"]) + ":" + urllib.parse.quote(os.environ["REDDIT_CLIENT_SECRET"])
        body = urllib.parse.urlencode({
            "grant_type": "password",
            "username": os.environ["REDDIT_USERNAME"],
            "password": os.environ["REDDIT_PASSWORD"],
        }).encode()
        req = urllib.request.Request(
            "https://www.reddit.com/api/v1/access_token", data=body,
            headers={"Authorization": "Basic " + __import__("base64").b64encode(auth.encode()).decode(),
                     "User-Agent": "product-factory/1.0 by " + os.environ["REDDIT_USERNAME"]},
            method="POST",
        )
        with urllib.request.urlopen(req, timeout=30) as resp:
            return json.loads(resp.read())["access_token"]

    def post(self, payload: dict[str, Any]) -> dict[str, Any]:
        sub = str(payload.get("subreddit", ""))[:21]
        title = str(payload.get("title", ""))[:300]
        text = str(payload.get("text", ""))[:3900]
        token = self._token()
        req = urllib.request.Request(
            "https://oauth.reddit.com/api/submit",
            data=urllib.parse.urlencode({"sr": sub, "title": title, "kind": "self", "text": text}).encode(),
            headers={"Authorization": f"Bearer {token}",
                     "User-Agent": "product-factory/1.0 by " + os.environ["REDDIT_USERNAME"]},
            method="POST",
        )
        try:
            with urllib.request.urlopen(req, timeout=30) as resp:
                data = json.loads(resp.read())
            ok = bool(data.get("json", {}).get("errors") is None or not data["json"]["errors"])
            errors = data.get("json", {}).get("errors") or []
            return {"ok": ok, "id": None, "error": None if ok else str(errors)[:200]}
        except Exception as e:  # noqa: BLE001
            return {"ok": False, "id": None, "error": str(e)[:200]}


class GitHubAdapter(Adapter):
    name = "github"
    env_required = ("GITHUB_TOKEN",)

    def post(self, payload: dict[str, Any]) -> dict[str, Any]:
        token = os.environ["GITHUB_TOKEN"]
        repo = str(payload.get("repo", "")) or ""
        body = {"tag_name": str(payload.get("tag", "v1.0.0"))[:60],
                "name": str(payload.get("name", "Release"))[:120],
                "body": str(payload.get("body", ""))[:3000],
                "draft": False, "prerelease": False}
        try:
            data = http_post_json(
                f"https://api.github.com/repos/{repo}/releases", body,
                headers={"Authorization": f"token {token}",
                         "Accept": "application/vnd.github+json"},
                timeout=30, retries=1,
            )
            html_url = data.get("html_url")
            return {"ok": bool(html_url), "id": data.get("id"), "error": None if html_url else str(data)[:200],
                    "url": html_url}
        except Exception as e:  # noqa: BLE001
            return {"ok": False, "id": None, "error": str(e)[:200]}


class XAdapter(Adapter):
    """X (Twitter) — OAuth2 user-context bearer. Requires a bearer token issued
    for a user (not the app-only token). Without proper OAuth the API refuses
    posting; the adapter reports that honestly instead of faking success."""

    name = "x"
    env_required = ("X_BEARER_TOKEN",)

    def post(self, payload: dict[str, Any]) -> dict[str, Any]:
        token = os.environ["X_BEARER_TOKEN"]
        text = str(payload.get("text", ""))[:270]
        try:
            data = http_post_json(
                "https://api.x.com/2/tweets", {"text": text},
                headers={"Authorization": f"Bearer {token}"}, timeout=30, retries=1,
            )
            tid = (data.get("data") or {}).get("id")
            return {"ok": bool(tid), "id": tid, "error": None if tid else str(data)[:200]}
        except Exception as e:  # noqa: BLE001
            return {"ok": False, "id": None, "error": str(e)[:200]}


class LinkedInAdapter(Adapter):
    """LinkedIn posts need an OAuth user token with the w_member_social scope;
    the adapter only activates when LINKEDIN_ACCESS_TOKEN is present."""

    name = "linkedin"
    env_required = ("LINKEDIN_ACCESS_TOKEN",)

    def post(self, payload: dict[str, Any]) -> dict[str, Any]:
        token = os.environ["LINKEDIN_ACCESS_TOKEN"]
        author = str(payload.get("author_urn", ""))
        if not author:
            return {"ok": False, "id": None, "error": "author_urn required (LINKEDIN_ORG_ID or person URN)"}
        body = {"author": author, "lifecycleState": "PUBLISHED",
                "specificContent": {"com.linkedin.ugc.ShareContent": {
                    "shareCommentary": {"text": str(payload.get("text", ""))[:2900]},
                    "shareMediaCategory": "NONE"}},
                "visibility": {"com.linkedin.ugc.MemberNetworkVisibility": "PUBLIC"}}
        try:
            data = http_post_json(
                "https://api.linkedin.com/v2/ugcPosts", body,
                headers={"Authorization": f"Bearer {token}",
                         "X-Restli-Protocol-Version": "2.0.0"},
                timeout=30, retries=1,
            )
            pid = data.get("id")
            return {"ok": bool(pid), "id": pid, "error": None if pid else str(data)[:200]}
        except Exception as e:  # noqa: BLE001
            return {"ok": False, "id": None, "error": str(e)[:200]}


class YouTubeAdapter(Adapter):
    """YouTube requires a full OAuth flow to obtain a refresh token; that flow
    needs a human browser. This adapter enforces the requirement instead of
    pretending: it is always dormant until a refresh token exists."""

    name = "youtube"
    env_required = ("YOUTUBE_CLIENT_ID", "YOUTUBE_CLIENT_SECRET", "YOUTUBE_REFRESH_TOKEN")

    def post(self, payload: dict[str, Any]) -> dict[str, Any]:
        return {"ok": False, "id": None,
                "error": "YouTube uploads need an OAuth refresh token set up via the "
                         "documented flow in README; adapter dormant until then."}


ALL_ADAPTERS: list[Adapter] = [
    TelegramAdapter, DevToAdapter, DiscordAdapter, BlueskyAdapter,
    MastodonAdapter, RedditAdapter, GitHubAdapter, XAdapter, LinkedInAdapter,
    YouTubeAdapter,
]