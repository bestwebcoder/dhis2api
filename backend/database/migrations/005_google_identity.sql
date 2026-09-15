BEGIN;

-- Google sign-in. An account is linked to a Google identity by the OpenID `sub`
-- claim, which Google guarantees never changes or gets reassigned — unlike the
-- email, which the owner can change on either side. The email stays the
-- account's display identity and its password sign-in name.
ALTER TABLE users ADD COLUMN google_subject varchar(255);
ALTER TABLE users ADD CONSTRAINT users_google_subject_unique UNIQUE (google_subject);

-- An account created through Google has no password. The check keeps every
-- account reachable by at least one sign-in method.
ALTER TABLE users ALTER COLUMN password_hash DROP NOT NULL;
ALTER TABLE users ADD CONSTRAINT users_has_credential
  CHECK (password_hash IS NOT NULL OR google_subject IS NOT NULL);

COMMENT ON COLUMN users.google_subject IS
  'Google OpenID subject (sub) linked to this account. NULL when Google sign-in is not connected.';
COMMENT ON COLUMN users.password_hash IS
  'scrypt hash; NULL for an account that only signs in with Google.';

COMMIT;
