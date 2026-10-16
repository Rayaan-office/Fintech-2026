"""Encrypted archive of original documents (S3-compatible store).

Files are encrypted by us (AES-256-GCM) before upload, so the store never holds readable
copies. Each object is named by its SHA-256 fingerprint, and the fingerprint is checked on
every read, so any change is detected.
"""

from functools import lru_cache

import boto3
from botocore.config import Config
from botocore.exceptions import ClientError

from .config import get_settings
from .security.crypto import archive as box
from .security.crypto import sha256_hex

_s = get_settings()


class ArchiveTampered(Exception):
    pass


@lru_cache(maxsize=1)
def _client():
    c = boto3.client(
        "s3", endpoint_url=_s.archive_s3_endpoint, aws_access_key_id=_s.archive_s3_access_key,
        aws_secret_access_key=_s.archive_s3_secret_key.get_secret_value(), region_name="us-east-1",
        config=Config(signature_version="s3v4", connect_timeout=5, read_timeout=30, retries={"max_attempts": 2},
                      s3={"addressing_style": "path"}),
    )
    try:
        c.head_bucket(Bucket=_s.archive_bucket)
    except ClientError:
        c.create_bucket(Bucket=_s.archive_bucket)
    return c


def object_key(business_id, sha256: str) -> str:
    return f"{business_id}/{sha256[:2]}/{sha256}"


def put(business_id, data: bytes) -> tuple[str, str]:
    """Store the original. Returns (object key, sha256)."""
    digest = sha256_hex(data)
    key = object_key(business_id, digest)
    _client().put_object(Bucket=_s.archive_bucket, Key=key, Body=box.seal(data),
                         Metadata={"sha256": digest}, ContentType="application/octet-stream")
    return key, digest


def get(key: str, expected_sha256: str) -> bytes:
    blob = _client().get_object(Bucket=_s.archive_bucket, Key=key)["Body"].read()
    data = box.open(blob)
    if sha256_hex(data) != expected_sha256:
        raise ArchiveTampered(key)
    return data
