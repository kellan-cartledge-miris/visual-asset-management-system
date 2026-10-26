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


def claim_held_by(s3_mock, task_token):
    """Make a mocked S3 client return a claim recorded by the execution holding `task_token`."""
    import io
    import json

    import mirisClaim

    s3_mock.get_object.side_effect = lambda **_: {
        "Body": io.BytesIO(json.dumps({"owner": mirisClaim.owner_id(task_token)}).encode())
    }
    return s3_mock
