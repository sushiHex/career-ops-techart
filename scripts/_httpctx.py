#!/usr/bin/env python
"""Shared TLS context for the scripts that fetch ATS endpoints directly.

Workday tenants serve a chain that terminates at ISRG Root YE, cross-signed up
through ISRG Root X2 to ISRG Root X1. The Windows ROOT store on this machine
carries neither of the newer ISRG roots, so OpenSSL keeps walking and lands on
DST Root CA X3, which expired 2021-09-30. Verification then fails with
"certificate has expired" against every `*.myworkdayjobs.com` host, while hosts
that serve a self-sufficient chain (Greenhouse, Ashby, Lever) verify fine. It is
the trust store that is stale, not the posting, so this is invisible until a
Workday fetch silently falls back or dies.

Each caller already carries a curl fallback, so this was survivable rather than
fatal. What it cost was speed and truth: `nvidia-liveness.py` classified the TLS
error as transient and burned its five-try exponential backoff, roughly sixteen
seconds of sleep per requisition, before reaching the path that works.

certifi ships a current bundle that contains the ISRG roots, so pointing OpenSSL
at it fixes verification at the source and lets the first attempt succeed. The
fallback to the platform default matters: if certifi is ever missing, callers
should degrade to their curl path rather than crash on import.
"""
import ssl


def build_context():
    """An SSL context that trusts certifi's bundle, falling back to the platform."""
    try:
        import certifi
    except ImportError:
        return ssl.create_default_context()
    try:
        return ssl.create_default_context(cafile=certifi.where())
    except Exception:
        return ssl.create_default_context()


# Built once at import. Contexts are reusable across connections and rebuilding
# one per request re-reads and re-parses the whole CA bundle.
CTX = build_context()


def is_tls_failure(exc):
    """True if `exc` is a TLS trust failure, which never resolves on retry.

    A caller that retries these with backoff pays the full sleep budget for an
    outcome that cannot change. Callers should skip straight to their fallback.
    """
    return isinstance(exc, ssl.SSLError)
