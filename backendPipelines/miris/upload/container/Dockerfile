# Copyright 2026 Amazon.com, Inc. or its affiliates. All Rights Reserved.
# SPDX-License-Identifier: Apache-2.0
FROM python:3.12-slim

ENV PYTHONDONTWRITEBYTECODE=1
ENV PYTHONUNBUFFERED=1

WORKDIR /opt/miris-upload

# Runtime dependencies, pinned so the container build is reproducible.
COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

COPY __init__.py __main__.py entrypoint.sh miris_uploader.py stream_metadata.py upload_config.py usd_packager.py ./
COPY utils/ utils/
# Normalize read bits: COPY preserves the build host's umask, so a hardened checkout (umask 077/027)
# leaves these root-owned 600/640 and unreadable to the non-root USER below.
RUN chmod -R a+rX /opt/miris-upload && chmod a+x entrypoint.sh

# The runtime user, and the one path it writes: /workdir holds the downloaded asset and the
# packaged upload.
RUN useradd --create-home --uid 10001 --user-group mirisupload && \
    mkdir -p /workdir && \
    chown mirisupload:mirisupload /workdir

USER mirisupload

ENTRYPOINT ["./entrypoint.sh"]
