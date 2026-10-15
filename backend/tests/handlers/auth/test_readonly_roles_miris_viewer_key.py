# Copyright 2026 Amazon.com, Inc. or its affiliates. All Rights Reserved.
# SPDX-License-Identifier: Apache-2.0

"""Read-only roles reach POST on the Miris viewer key route and no other POST under /database.

In per-view viewer key mode the viewer mints a key with
``POST /database/{databaseId}/assets/{assetId}/miris/viewer-key`` (``API_MIRIS_VIEWER_KEY``), whose
handler checks Tier 1 with ``enforceAPI`` on the concrete request path. The read-only templates
(``database-readonly``, ``global-readonly``) and the seeded ``basicReadOnly`` role
(``dynamodb-authdefaults-ro-construct.ts``) carry a dedicated constraint for it whose two
``criteriaAnd`` criteria must both hold: ``route__path`` starts with ``/database`` AND ends with
``/miris/viewer-key``. Either criterion alone would open a wider POST, so each is checked here at the
Casbin level, through the real policy generation and evaluation, with only the table reads stubbed.

The seeded role is read out of the construct source, so the test follows what a deployment writes to
DynamoDB rather than a hand copy of it.
"""

import json
import pathlib
import re
from unittest.mock import MagicMock, patch

import pytest

import backend.backend.handlers.authz as authz_module  # noqa: E402
from backend.backend.common.apiRoutes import (  # noqa: E402
    API_MIRIS_ASSET_STATUS,
    API_MIRIS_VIEWER_KEY,
)
from backend.backend.handlers.auth import authConstraintsTemplateService as svc  # noqa: E402

REPO_ROOT = pathlib.Path(__file__).resolve().parents[4]
TEMPLATES_DIR = REPO_ROOT / "documentation" / "permissionsTemplates"
RO_CONSTRUCT = (REPO_ROOT / "infra" / "lib" / "nestedStacks" / "auth" / "constructs"
                / "dynamodb-authdefaults-ro-construct.ts")

READONLY_TEMPLATES = ("database-readonly.json", "global-readonly.json")
DATABASE_ID = "db1"
ROLE_NAME = "template-role"
SEEDED_ROLE_NAME = "basicReadOnly"
USER_ID = "readonly-user"
VARIABLE_VALUES = {"ROLE_NAME": ROLE_NAME, "DATABASE_ID": DATABASE_ID}

VIEWER_KEY_PATH = f"/database/{DATABASE_ID}/assets/a1/miris/viewer-key"
STATUS_PATH = f"/database/{DATABASE_ID}/assets/a1/miris/asset-status"
DENIED_POST_PATHS = (
    f"/database/{DATABASE_ID}/assets/a1",
    STATUS_PATH,
    "/auth/x/miris/viewer-key",
    f"/database/{DATABASE_ID}/assets/a1/miris/viewer-key/extra",
    f"/database/{DATABASE_ID}/assets/a1/miris/viewer-keys",
)


def _template_constraints(template_name):
    """The constraints an import of the template stores, in the shape the policy builder reads."""
    document = json.loads((TEMPLATES_DIR / template_name).read_text(encoding="utf-8"))
    constraints = [
        {
            "name": constraint["name"],
            "description": constraint["description"],
            "objectType": constraint["objectType"],
            "criteriaAnd": constraint.get("criteriaAnd", []),
            "criteriaOr": constraint.get("criteriaOr", []),
            "groupPermissions": constraint.get("groupPermissions", []),
        }
        for constraint in document["constraints"]
    ]
    substituted = svc.substitute_variables(constraints, VARIABLE_VALUES)
    return [svc.build_constraint_data(constraint, ROLE_NAME, {"tokens": [USER_ID]})
            for constraint in substituted]


_CONSTRAINT_ID_RE = re.compile(r"constraintId: \{\s*S: `initial_\$\{roleNameIDClean\}_([A-Za-z0-9_]+)`")
_CRITERION_RE = re.compile(
    r'field: \{\s*S: "([^"]*)",?\s*\},\s*'
    r"id: \{\s*S: [^\n]*\s*\},\s*"
    r'operator: \{\s*S: "([^"]*)",?\s*\},\s*'
    r'value: \{\s*S: "([^"]*)"'
)
_PERMISSION_RE = re.compile(
    r'permission: \{\s*S: "([^"]*)",?\s*\},\s*permissionType: \{\s*S: "([^"]*)"')
_OBJECT_TYPE_RE = re.compile(r'objectType: \{\s*S: "([^"]*)"')


def _criteria(segment, key):
    """(field, operator, value) criteria of one list; it ends at whichever key follows it."""
    start = segment.find(f"{key}: {{")
    if start == -1:
        return []
    ends = [i for i in (segment.find("description: {", start),
                        segment.find("criteriaAnd: {" if key == "criteriaOr" else "criteriaOr: {", start))
            if i > -1]
    region = segment[start:min(ends) if ends else len(segment)]
    criteria = [{"field": f, "operator": o, "value": v} for f, o, v in _CRITERION_RE.findall(region)]
    if len(criteria) != region.count("field: {"):
        raise AssertionError(f"{key}: the reader is out of step with the construct")
    return criteria


def _seeded_constraints():
    """The seeded basicReadOnly constraints, read from the construct source.

    A criterion behind a config-gated spread is read as present, which only widens the role, so it
    cannot make a denial below pass.
    """
    # Whole-line comments are dropped first, so a commented-out criterion is not read as live.
    source = re.sub(r"^[ \t]*//[^\n]*\n", "", RO_CONSTRUCT.read_text(encoding="utf-8"), flags=re.M)
    starts = [(m.group(1), m.start()) for m in _CONSTRAINT_ID_RE.finditer(source)]
    constraints = []
    for index, (constraint_id, start) in enumerate(starts):
        end = starts[index + 1][1] if index + 1 < len(starts) else len(source)
        segment = source[start:end]
        permissions_at = segment.find("groupPermissions: {")
        object_type = _OBJECT_TYPE_RE.search(segment[permissions_at:])
        constraints.append({
            "constraintId": constraint_id,
            "objectType": object_type.group(1),
            "criteriaAnd": _criteria(segment, "criteriaAnd"),
            "criteriaOr": _criteria(segment, "criteriaOr"),
            "groupPermissions": [
                {"groupId": SEEDED_ROLE_NAME, "permission": permission, "permissionType": kind}
                for permission, kind in _PERMISSION_RE.findall(segment[permissions_at:])
            ],
        })
    return constraints


@pytest.fixture
def role_enforcer():
    """Build the real CasbinEnforcer for one role from a list of stored constraints.

    Only the two table reads are stubbed and the denial audit writer is replaced. The per-user
    caches are cleared on every build and restored afterwards.
    """
    state = {"constraints": [], "role": ROLE_NAME}
    previous_policy_map = authz_module.casbin_user_policy_map
    previous_enforcer_map = authz_module.casbin_user_enforcer_map

    def build(constraints, role_name=ROLE_NAME):
        state["constraints"] = constraints
        state["role"] = role_name
        authz_module.casbin_user_policy_map = {}
        authz_module.casbin_user_enforcer_map = {}
        return authz_module.CasbinEnforcer(
            {"tokens": [USER_ID], "roles": [role_name], "mfaEnabled": True})

    with patch.object(
        authz_module.CasbinEnforcerService, "_read_current_user_roles_from_table",
        side_effect=lambda: [{"userId": USER_ID, "roleName": state["role"]}],
    ), patch.object(
        authz_module.CasbinEnforcerService, "_read_policies_batch_optimized",
        side_effect=lambda role_names: state["constraints"],
    ), patch.object(authz_module, "log_authorization", MagicMock()):
        try:
            yield build
        finally:
            authz_module.casbin_user_policy_map = previous_policy_map
            authz_module.casbin_user_enforcer_map = previous_enforcer_map


def _api(path):
    """The Tier-1 object ``enforceAPI`` evaluates for a request path."""
    return {"object__type": "api", "route__path": path}


def _readonly_roles():
    """(id, constraints, role name) for each read-only template and the seeded role."""
    roles = [(name, _template_constraints(name), ROLE_NAME) for name in READONLY_TEMPLATES]
    roles.append(("seeded-basicReadOnly", _seeded_constraints(), SEEDED_ROLE_NAME))
    return roles


READONLY_ROLES = _readonly_roles()
ROLE_IDS = [role[0] for role in READONLY_ROLES]


def _without_viewer_key_grant(constraints):
    return [c for c in constraints
            if not any(criterion.get("value") == "/miris/viewer-key"
                       for criterion in c.get("criteriaAnd", []) + c.get("criteriaOr", []))]


def _viewer_key_grants(constraints):
    return [c for c in constraints
            if any(criterion.get("value") == "/miris/viewer-key"
                   for criterion in c.get("criteriaAnd", []) + c.get("criteriaOr", []))]


@pytest.mark.unit
class TestReadOnlyRolesMintViewerKeys:

    def test_the_paths_are_the_registered_routes(self):
        assert API_MIRIS_VIEWER_KEY.matches(VIEWER_KEY_PATH)
        assert API_MIRIS_ASSET_STATUS.matches(STATUS_PATH)
        assert API_MIRIS_VIEWER_KEY.methods == ("POST",)

    @pytest.mark.parametrize("role_id,constraints,role_name", READONLY_ROLES, ids=ROLE_IDS)
    def test_post_on_the_viewer_key_route_is_allowed(self, role_enforcer, role_id, constraints, role_name):
        enforcer = role_enforcer(constraints, role_name)
        assert enforcer.enforce(_api(VIEWER_KEY_PATH), "POST") is True

    @pytest.mark.parametrize("path", DENIED_POST_PATHS)
    @pytest.mark.parametrize("role_id,constraints,role_name", READONLY_ROLES, ids=ROLE_IDS)
    def test_post_elsewhere_is_denied(self, role_enforcer, role_id, constraints, role_name, path):
        enforcer = role_enforcer(constraints, role_name)
        assert enforcer.enforce(_api(path), "POST") is False

    @pytest.mark.parametrize("method", ["PUT", "DELETE"])
    @pytest.mark.parametrize("role_id,constraints,role_name", READONLY_ROLES, ids=ROLE_IDS)
    def test_no_other_write_method_reaches_the_viewer_key_route(
            self, role_enforcer, role_id, constraints, role_name, method):
        enforcer = role_enforcer(constraints, role_name)
        assert enforcer.enforce(_api(VIEWER_KEY_PATH), method) is False

    @pytest.mark.parametrize("role_id,constraints,role_name", READONLY_ROLES, ids=ROLE_IDS)
    def test_get_on_the_status_route_is_still_allowed(self, role_enforcer, role_id, constraints, role_name):
        enforcer = role_enforcer(constraints, role_name)
        assert enforcer.enforce(_api(STATUS_PATH), "GET") is True


@pytest.mark.unit
class TestTheGrantIsOneAndCombinedConstraint:
    """Controls: the dedicated constraint is what grants the route, and it needs both criteria."""

    @pytest.mark.parametrize("role_id,constraints,role_name", READONLY_ROLES, ids=ROLE_IDS)
    def test_without_the_constraint_the_route_is_denied(self, role_enforcer, role_id, constraints, role_name):
        enforcer = role_enforcer(_without_viewer_key_grant(constraints), role_name)
        assert enforcer.enforce(_api(VIEWER_KEY_PATH), "POST") is False
        # The rest of the role still works, so the denial is not an empty policy.
        assert enforcer.enforce(_api(STATUS_PATH), "GET") is True

    @pytest.mark.parametrize("role_id,constraints,role_name", READONLY_ROLES, ids=ROLE_IDS)
    def test_the_grant_is_a_separate_post_only_and_constraint(self, role_id, constraints, role_name):
        grants = _viewer_key_grants(constraints)
        assert len(grants) == 1
        grant = grants[0]
        assert grant["objectType"] == "api"
        assert grant["criteriaOr"] in ([], None)
        assert sorted((c["field"], c["operator"], c["value"]) for c in grant["criteriaAnd"]) == [
            ("route__path", "ends_with", "/miris/viewer-key"),
            ("route__path", "starts_with", "/database"),
        ]
        assert [(p["permission"], p["permissionType"]) for p in grant["groupPermissions"]] == [
            ("POST", "allow")]

    @pytest.mark.parametrize("dropped", ["starts_with", "ends_with"])
    @pytest.mark.parametrize("role_id,constraints,role_name", READONLY_ROLES, ids=ROLE_IDS)
    def test_either_criterion_alone_would_open_a_wider_post(
            self, role_enforcer, role_id, constraints, role_name, dropped):
        """The criteria combine with AND: with one removed, a path the other excludes is allowed."""
        narrowed = []
        for constraint in constraints:
            if constraint in _viewer_key_grants(constraints):
                constraint = dict(constraint)
                constraint["criteriaAnd"] = [c for c in constraint["criteriaAnd"]
                                             if c["operator"] != dropped]
            narrowed.append(constraint)
        enforcer = role_enforcer(narrowed, role_name)
        widened = "/auth/x/miris/viewer-key" if dropped == "starts_with" else STATUS_PATH
        assert enforcer.enforce(_api(widened), "POST") is True


@pytest.mark.unit
class TestTheSeededRoleReader:

    def test_the_reader_finds_the_seeded_api_constraints(self):
        constraints = {c["constraintId"]: c for c in _seeded_constraints()}
        assert {"allow_get_apis", "deny_execution_logs", "allow_post_apis",
                "allow_miris_viewer_key_post"} <= set(constraints)
        post = constraints["allow_post_apis"]
        assert {"field": "route__path", "operator": "starts_with", "value": "/search"} in post["criteriaOr"]
        assert post["groupPermissions"] == [
            {"groupId": SEEDED_ROLE_NAME, "permission": "POST", "permissionType": "allow"}]
        deny = constraints["deny_execution_logs"]
        assert deny["groupPermissions"][0]["permissionType"] == "deny"
