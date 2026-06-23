#  Copyright 2026 Amazon.com, Inc. or its affiliates. All Rights Reserved.
#  SPDX-License-Identifier: Apache-2.0
"""
Pytest configuration for MirisUploadGate Lambda tests.

Stubs out aws_lambda_powertools (not installed locally) so the Lambda module
can be imported without the production dependency being present.
"""
import sys
from unittest.mock import MagicMock


def _make_customLogging_stub():
    """Return a minimal customLogging.logger stub module."""

    class _SafeLogger:
        def __init__(self, **kwargs):
            pass

        def info(self, *args, **kwargs):
            pass

        def warning(self, *args, **kwargs):
            pass

        def error(self, *args, **kwargs):
            pass

        def exception(self, *args, **kwargs):
            pass

    stub = MagicMock()
    stub.safeLogger = _SafeLogger
    return stub


# Register stubs before any test module is collected so that the first
# `import mirisUploadGate` inside a test body succeeds.
_customLogging_stub = _make_customLogging_stub()
sys.modules.setdefault("customLogging", _customLogging_stub)
sys.modules.setdefault("customLogging.logger", _customLogging_stub)
