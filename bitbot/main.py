#!/usr/bin/env python3
"""Server-side Seedance 2.5 text-to-video via the official Higgsfield SDK."""

from __future__ import annotations

import os
import sys
from pathlib import Path

from dotenv import load_dotenv
from higgsfield_client import (
    Cancelled,
    CredentialsMissedError,
    Failed,
    HiggsfieldClientError,
    NSFW,
    subscribe,
)

load_dotenv(Path(__file__).resolve().parent / ".env.local")

MODEL = "bytedance/seedance-2.5/text-to-video"
FAILURE_STATUSES = frozenset({"failed", "canceled", "cancelled", "nsfw", "moderated"})


def _status_of(result: object) -> str:
    if isinstance(result, dict):
        raw = result.get("status") or result.get("state") or result.get("request_status")
        return str(raw or "").strip().lower()
    return str(getattr(result, "status", "") or "").strip().lower()


def _video_url(result: object) -> str | None:
    if not isinstance(result, dict):
        return None
    video = result.get("video")
    if isinstance(video, dict):
        url = video.get("url")
        if url:
            return str(url)
    if isinstance(video, str) and video.startswith("http"):
        return video
    videos = result.get("videos")
    if isinstance(videos, list) and videos:
        first = videos[0]
        if isinstance(first, dict) and first.get("url"):
            return str(first["url"])
        if isinstance(first, str) and first.startswith("http"):
            return first
    images = result.get("images")
    if isinstance(images, list) and images and isinstance(images[0], dict):
        url = images[0].get("url")
        if url and str(url).lower().endswith((".mp4", ".mov", ".webm")):
            return str(url)
    return None


def main() -> int:
    credentials = os.environ.get("HF_KEY") or os.environ.get("HF_CREDENTIALS")
    if not credentials or ":" not in credentials:
        print(
            "HF_KEY is missing or not in key-id:key-secret format.",
            file=sys.stderr,
        )
        print("Add it to .env.local on this machine. Do not paste it in chat.", file=sys.stderr)
        return 2

    try:
        result = subscribe(
            MODEL,
            arguments={
                "prompt": "A cinematic scene at sunset",
                "duration": 5,
                "resolution": "720p",
                "aspect_ratio": "16:9",
            },
        )
    except CredentialsMissedError:
        print("HF_KEY is not available to the SDK. Add it to .env.local locally.", file=sys.stderr)
        return 2
    except HiggsfieldClientError as exc:
        print(f"Generation request failed: {exc}", file=sys.stderr)
        return 1
    except Exception as exc:
        name = type(exc).__name__
        if name in {"Failed", "NSFW", "Cancelled"} or isinstance(exc, (Failed, NSFW, Cancelled)):
            print(f"Generation did not succeed ({name}).", file=sys.stderr)
            return 1
        print(f"Generation request failed: {exc}", file=sys.stderr)
        return 1

    status = _status_of(result)
    if status in FAILURE_STATUSES:
        print(f"Generation did not succeed ({status}).", file=sys.stderr)
        return 1

    url = _video_url(result)
    if not url:
        if status and status not in {"completed", "complete", "succeeded", "success", ""}:
            print(f"Generation did not succeed ({status}).", file=sys.stderr)
            return 1
        print("Generation finished without a video URL.", file=sys.stderr)
        return 1

    print(url)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
