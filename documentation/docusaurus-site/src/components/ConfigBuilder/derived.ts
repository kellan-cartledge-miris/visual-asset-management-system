/*
 * Copyright 2023 Amazon.com, Inc. or its affiliates. All Rights Reserved.
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Derived-state engine.
 *
 * `getConfig()` does not rewrite the operator's configuration to satisfy a
 * constraint. Where a feature combination is invalid it rejects the configuration
 * and names the offending fields, so a change in deployment topology is never made
 * on the operator's behalf without their seeing it. The builder mirrors that
 * posture, and every such constraint surfaces as a validation error instead (see
 * `validation.ts`).
 *
 * The one `getConfig()` auto-mutation is the legacy Miris alias resolution
 * (config.ts: `resolveMirisLegacyAlias`): a value at `app.miris.upload.apiKeySecretArn`
 * or `app.miris.upload.mirisApiBaseUrl` fills the unset `app.miris` setting of the
 * same name, and the legacy key is removed. `applyDerived()` mirrors exactly that.
 * `ConfigBuilder.commitConfig()` funnels every field edit through it, and anything
 * added here must correspond to an assignment `getConfig()` actually performs on
 * the operator's config (see the sync steps in the component README).
 *
 * The GovCloud CloudFront/Location constraints are not applied here either: they
 * are hard errors in `getConfig()`, and flipping the operator's front-end choice
 * would be fighting them. They surface as validation errors, alongside the
 * user-initiated "Apply GovCloud-safe defaults" action in the UI, which is
 * `applyGovCloudSafeDefaults()` below.
 */

import type { ConfigShape, DerivedChange } from "./types";
import { getByPath, setByPath } from "./pathUtils";

export interface DerivedResult {
    config: ConfigShape;
    changes: DerivedChange[];
}

/** Settings read from `app.miris` whose legacy location is `app.miris.upload`. */
const MIRIS_LEGACY_ALIAS_FIELDS = ["apiKeySecretArn", "mirisApiBaseUrl"];

/** config.ts `isMirisValueUnset`: missing, null, empty, or the template placeholder. */
function isMirisValueUnset(value: unknown): boolean {
    return value == null || value === "" || value === "UNDEFINED";
}

/**
 * Apply implied state. Returns the config plus the list of fields that were forced,
 * for visible "auto-adjusted" feedback in the UI. Idempotent.
 *
 * A legacy Miris value that conflicts with a set `app.miris` value is left in place
 * for the `miris-legacy-*-conflict` validation rules to report, as `getConfig()`
 * rejects that configuration rather than choosing between the two.
 */
export function applyDerived(input: ConfigShape): DerivedResult {
    let next = input;
    const changes: DerivedChange[] = [];
    for (const field of MIRIS_LEGACY_ALIAS_FIELDS) {
        const upload = getByPath(next, "app.miris.upload");
        if (upload == null || !(field in upload)) continue;
        const legacy = upload[field];
        const current = getByPath(next, `app.miris.${field}`);
        if (!isMirisValueUnset(legacy)) {
            if (isMirisValueUnset(current)) {
                next = setByPath(next, `app.miris.${field}`, legacy);
                changes.push({
                    path: `app.miris.${field}`,
                    to: legacy,
                    reason: `app.miris.upload.${field} is deprecated; its value moved to app.miris.${field}.`,
                });
            } else if (current !== legacy) {
                continue;
            }
        }
        const { [field]: _removed, ...rest } = upload;
        next = setByPath(next, "app.miris.upload", rest);
    }
    return { config: next, changes };
}

/**
 * User-initiated helper for the GovCloud error case: flip the config to a
 * GovCloud-safe front-end posture (CloudFront off, ALB on, Location off, VPC on).
 * Returned as a new config; the caller decides when to invoke it.
 */
export function applyGovCloudSafeDefaults(input: ConfigShape): ConfigShape {
    let next = input;
    next = setByPath(next, "app.useGlobalVpc.enabled", true);
    next = setByPath(next, "app.useCloudFront.enabled", false);
    next = setByPath(next, "app.useAlb.enabled", true);
    next = setByPath(next, "app.useLocationService.enabled", false);
    return next;
}
