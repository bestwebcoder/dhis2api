BEGIN;

-- Control-plane operators. A user is the `actor` behind every audited change;
-- DHIS2 credentials in dhis2_connections are unrelated to these accounts.
CREATE TABLE users (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  email varchar(254) NOT NULL,
  name varchar(120) NOT NULL,
  organisation varchar(160) NOT NULL DEFAULT 'Unassigned',
  role varchar(20) NOT NULL DEFAULT 'analyst' CHECK (role IN ('admin', 'analyst')),
  -- scrypt$N$r$p$<base64 salt>$<base64 derived key>; never a reversible secret
  password_hash text NOT NULL,
  is_active boolean NOT NULL DEFAULT true,
  last_login_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  -- emails are stored pre-normalised to lower case by the API
  CONSTRAINT users_email_unique UNIQUE (email)
);

CREATE INDEX users_active_idx ON users (is_active);

COMMIT;
