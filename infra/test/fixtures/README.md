# Test fixture directory

`tagDatabaseScopeGrants.test.ts` builds a `LayerVersion` with
`Code.fromAsset(path.join(__dirname, "fixtures"))`. A Lambda layer rejects inline code, so the test
needs some directory on disk to point at — its contents are never executed or asserted on.

This directory exists so that asset resolves. Without it the suite fails with
`«CannotFindAsset» Cannot find asset at .../infra/test/fixtures`.
