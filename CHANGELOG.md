# edge-server-tools

## 0.2.0 (2021-06-25)

### Fixes

- Improved `autoReplication` and `dbReplication` functions.

### Changes

- Add ESM entry point for modern Node.js versions.
- Add required `databases` parameter to `autoReplication`.
- Replace database setup methods `prepareCouch` and `rebuildCouch` with a new `setupDatabase` helper.
- Improve error handling, removing `ServerUtilError` in favor of `errorCause`.

### Added

- Add `asCouchDoc` cleaner function.
- Add `forEachDocument` Couch utility function.
- Add `bulkGet` Couch utility function.
- Add type definitions & helper methods for working with design documents.
- New `errorCause` based on the [error cause TC39 proposal](https://github.com/tc39/proposal-error-cause).

### Removed

- `prepareCouch` - Use `setupDatabase` instead.
- `rebuildCouch` - Use `setupDatabase` instead.
- `ServerUtilError` - Use `errorCause` instead.

## 0.1.0 (2021-03-19)

### Changed
- Initial publish