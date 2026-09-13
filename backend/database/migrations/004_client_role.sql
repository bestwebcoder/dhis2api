BEGIN;

-- The non-admin role is a *client*: an account that may only ever see the
-- connections, blueprints, syncs and rows it owns. "analyst" was the earlier
-- name for the same seat, back when a non-admin could read the whole control
-- plane; the rename and the isolation land together.
ALTER TABLE users DROP CONSTRAINT IF EXISTS users_role_check;
UPDATE users SET role = 'client' WHERE role = 'analyst';
ALTER TABLE users ALTER COLUMN role SET DEFAULT 'client';
ALTER TABLE users ADD CONSTRAINT users_role_check CHECK (role IN ('admin', 'client'));

-- Ownership is the isolation boundary, so it has to be readable quickly and
-- must never be ambiguous: a row with a null created_by predates the boundary
-- and is visible to administrators only.
COMMENT ON COLUMN dhis2_connections.created_by IS
  'Owning account. NULL means unowned: visible to administrators only.';
COMMENT ON COLUMN schema_blueprints.created_by IS
  'Owning account. NULL means unowned: visible to administrators only.';
COMMENT ON COLUMN sync_definitions.created_by IS
  'Owning account. NULL means unowned: visible to administrators only.';

COMMIT;
