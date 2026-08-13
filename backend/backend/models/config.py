# Copyright 2023 Amazon.com, Inc. or its affiliates. All Rights Reserved.
# SPDX-License-Identifier: Apache-2.0

from aws_lambda_powertools.utilities.parser import BaseModel


class SecureConfigResponseModel(BaseModel, extra='ignore'):
    """Response model for the runtime secure configuration"""
    featuresEnabled: str = ""
    locationServiceApiUrl: str = ""
    webDeployedUrl: str = ""
    # Miris Spatial Streaming viewer key (deployment-wide). Empty string when the
    # MIRIS_VIEWER_KEY env var is unset; the frontend treats empty as "not
    # configured" and the Miris streaming viewer plugin stays inactive.
    mirisViewerKey: str = ""
