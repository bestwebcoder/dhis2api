BEGIN;

-- Ownership. Every control-plane object records the account that created it, so
-- a dashboard can be scoped to one person's work and a delete can report what it
-- would orphan. ON DELETE SET NULL is deliberate: removing an operator must never
-- cascade into the connections, blueprints and syncs they built.
ALTER TABLE dhis2_connections ADD COLUMN created_by uuid REFERENCES users(id) ON DELETE SET NULL;
ALTER TABLE schema_blueprints ADD COLUMN created_by uuid REFERENCES users(id) ON DELETE SET NULL;
ALTER TABLE sync_definitions ADD COLUMN created_by uuid REFERENCES users(id) ON DELETE SET NULL;
ALTER TABLE sync_runs       ADD COLUMN triggered_by uuid REFERENCES users(id) ON DELETE SET NULL;

CREATE INDEX dhis2_connections_created_by_idx ON dhis2_connections (created_by);
CREATE INDEX schema_blueprints_created_by_idx ON schema_blueprints (created_by);
CREATE INDEX sync_definitions_created_by_idx  ON sync_definitions (created_by);

-- Which administrator provisioned the account; null for the bootstrap admin and
-- for anyone who signed themselves up while AUTH_ALLOW_SIGNUP was open.
ALTER TABLE users ADD COLUMN created_by uuid REFERENCES users(id) ON DELETE SET NULL;

-- audit_log.actor keeps the readable name forever; actor_id links to the account
-- while it still exists. Destructive routes write here before they commit.
ALTER TABLE audit_log ADD COLUMN actor_id uuid REFERENCES users(id) ON DELETE SET NULL;
CREATE INDEX audit_log_actor_idx  ON audit_log (actor_id, created_at DESC);
CREATE INDEX audit_log_entity_idx ON audit_log (entity_type, entity_id, created_at DESC);

COMMIT;
