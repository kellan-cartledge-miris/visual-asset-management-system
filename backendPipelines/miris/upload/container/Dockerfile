# Copyright 2026 Amazon.com, Inc. or its affiliates. All Rights Reserved.
# SPDX-License-Identifier: Apache-2.0
FROM python:3.12-slim

WORKDIR /opt/miris-upload

# Install runtime deps. We pin so the container build is reproducible.
COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

# Copy the application
COPY __init__.py .
COPY __main__.py .
COPY entrypoint.sh .
COPY config.json .
COPY pipeline_vams.py .
COPY miris_uploader.py .
COPY utils/ utils/

RUN chmod +x entrypoint.sh

ENTRYPOINT ["./entrypoint.sh"]
