/*
 * Copyright 2026 Amazon.com, Inc. or its affiliates. All Rights Reserved.
 * SPDX-License-Identifier: Apache-2.0
 */

import * as Config from "../../../config/config";

/**
 * `route__path` criteria the enabled add-ons add to the basic read-only role's
 * "Allow GET on API Paths" constraint (`dynamodb-authdefaults-ro-construct.ts`),
 * in that constraint's DynamoDB attribute-value shape.
 */
export function addonReadOnlyApiRouteCriteria(config: Config.Config, roleIdClean: string): any[] {
    return [
        ...(config.app.addons.usePhysnaSync.enabled
            ? [
                  {
                      M: {
                          field: {
                              S: "route__path",
                          },
                          id: {
                              S: `16_${roleIdClean}_api_paths`,
                          },
                          operator: {
                              S: "starts_with",
                          },
                          value: {
                              S: "/addon/physna/viewer", //Physna viewer proxy (per-asset authorization is enforced server-side)
                          },
                      },
                  },
              ]
            : []),
    ];
}

/**
 * `route__path` criteria the enabled add-ons add to the basic read-only role's
 * "Allow POST on API Paths" constraint (`dynamodb-authdefaults-ro-construct.ts`), for add-on routes
 * that read through a POST body, in that constraint's DynamoDB attribute-value shape. They follow
 * the constraint's core criteria, and `assertAddonApiRouteCriteria()` checks them at synthesis.
 */
export function addonReadOnlyApiPostRouteCriteria(
    config: Config.Config,
    roleIdClean: string
): any[] {
    return [];
}

/** An add-on criterion's route: `/addon/<name>/` followed by the add-on's own path. */
const ADDON_ROUTE_VALUE_PREFIX = /^\/addon\/[a-z0-9-]+\//;

/** Regular-expression metacharacters, refused in a criterion value. */
const ROUTE_VALUE_METACHARACTERS = /[|.*+?()[\]{}^$\\]/;

const ADDON_ROUTE_OPERATORS = ["equals", "starts_with"];

/**
 * Fails synthesis unless every add-on criterion is a `route__path` criterion, with operator
 * `equals` or `starts_with`, on a value under `/addon/<name>/` that holds no regular-expression
 * metacharacter, and with an id that ends in `idSuffix` and repeats no other criterion id of the
 * constraint it joins. `constraintCriteria` is that constraint's whole `criteriaOr` list, add-on
 * criteria included.
 */
export function assertAddonApiRouteCriteria(
    addonCriteria: any[],
    constraintCriteria: any[],
    idSuffix: string
): void {
    const ownIds = constraintCriteria
        .filter((criterion) => !addonCriteria.includes(criterion))
        .map((criterion) => criterion?.M?.id?.S);
    const seenAddonIds: string[] = [];

    for (const criterion of addonCriteria) {
        const refuse = (reason: string): never => {
            throw new Error(
                `Add-on read-only route criterion ${JSON.stringify(criterion)} is not accepted: ` +
                    `${reason}.`
            );
        };
        const fields = criterion?.M;
        const [field, id, operator, value] = ["field", "id", "operator", "value"].map(
            (key) => fields?.[key]?.S
        );
        if ([field, id, operator, value].some((part) => typeof part !== "string")) {
            refuse("field, id, operator and value must each be { S: string }");
        }
        if (field !== "route__path") {
            refuse("the field must be route__path");
        }
        if (!ADDON_ROUTE_OPERATORS.includes(operator)) {
            refuse("the operator must be equals or starts_with");
        }
        if (!ADDON_ROUTE_VALUE_PREFIX.test(value)) {
            refuse("the value must start with /addon/<name>/, where <name> matches [a-z0-9-]+");
        }
        if (ROUTE_VALUE_METACHARACTERS.test(value)) {
            refuse("the value must hold no regular-expression metacharacter");
        }
        if (!id.endsWith(idSuffix)) {
            refuse(`the id must end in ${idSuffix}`);
        }
        if (ownIds.includes(id) || seenAddonIds.includes(id)) {
            refuse("the id repeats another criterion id of the constraint");
        }
        seenAddonIds.push(id);
    }
}
