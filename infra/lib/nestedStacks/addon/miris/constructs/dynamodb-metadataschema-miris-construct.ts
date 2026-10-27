/*
 * Copyright 2026 Amazon.com, Inc. or its affiliates. All Rights Reserved.
 * SPDX-License-Identifier: Apache-2.0
 */

import * as iam from "aws-cdk-lib/aws-iam";
import { AwsCustomResource, AwsSdkCall, PhysicalResourceId } from "aws-cdk-lib/custom-resources";
import { Construct } from "constructs";
import { storageResources } from "../../../storage/storageBuilder-nestedStack";
import mirisStreamSchema from "./dynamodb-metadataschema-miris-stream.json";

export interface DynamoDbMetadataSchemaMirisConstructProps {
    customResourceRole: iam.IRole;
    storageResources: storageResources;
}

/**
 * Deploys the GLOBAL "Miris stream" file metadata schema to the metadata schema table.
 * The schema definition (fields, entity type, file extension restriction) is read from
 * dynamodb-metadataschema-miris-stream.json, which the backend model tests also validate.
 */
export class DynamoDbMetadataSchemaMirisConstruct extends Construct {
    constructor(parent: Construct, name: string, props: DynamoDbMetadataSchemaMirisConstructProps) {
        super(parent, name);

        const now = new Date().toISOString();
        const tableName = props.storageResources.dynamo.metadataSchemaStorageTableV2.tableName;

        const awsSdkCallMirisStream: AwsSdkCall = {
            service: "DynamoDB",
            action: "putItem",
            parameters: {
                TableName: tableName,
                Item: {
                    metadataSchemaId: {
                        S: mirisStreamSchema.metadataSchemaId,
                    },
                    "databaseId:metadataEntityType": {
                        S: `${mirisStreamSchema.databaseId}:${mirisStreamSchema.metadataSchemaEntityType}`,
                    },
                    databaseId: {
                        S: mirisStreamSchema.databaseId,
                    },
                    metadataSchemaEntityType: {
                        S: mirisStreamSchema.metadataSchemaEntityType,
                    },
                    schemaName: {
                        S: mirisStreamSchema.schemaName,
                    },
                    fileKeyTypeRestriction: {
                        S: mirisStreamSchema.fileKeyTypeRestriction,
                    },
                    fields: {
                        S: JSON.stringify({ fields: mirisStreamSchema.fields }),
                    },
                    enabled: {
                        BOOL: mirisStreamSchema.enabled,
                    },
                    dateCreated: {
                        S: now,
                    },
                    dateModified: {
                        S: now,
                    },
                    createdBy: {
                        S: "SYSTEM_USER",
                    },
                    modifiedBy: {
                        S: "SYSTEM_USER",
                    },
                },
            },
            physicalResourceId: PhysicalResourceId.of(tableName + `_mirisstream_initialization`),
        };

        new AwsCustomResource(this, `metadataSchemaStorageTable_MirisStreamCustomResource`, {
            onCreate: awsSdkCallMirisStream,
            onUpdate: awsSdkCallMirisStream,
            role: props.customResourceRole,
        });
    }
}
