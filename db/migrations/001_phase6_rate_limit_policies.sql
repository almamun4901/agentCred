BEGIN;

CREATE TABLE IF NOT EXISTS rate_limit_policies (
    principal TEXT NOT NULL,
    audience TEXT NOT NULL,
    scope TEXT NOT NULL,
    window_seconds INTEGER NOT NULL,
    max_requests INTEGER NOT NULL,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY (principal, audience, scope),
    CONSTRAINT rate_limit_policies_principal_not_blank CHECK (btrim(principal) <> ''),
    CONSTRAINT rate_limit_policies_audience_not_blank CHECK (btrim(audience) <> ''),
    CONSTRAINT rate_limit_policies_scope_not_blank CHECK (btrim(scope) <> ''),
    CONSTRAINT rate_limit_policies_window_valid CHECK (window_seconds BETWEEN 1 AND 3600),
    CONSTRAINT rate_limit_policies_max_requests_valid CHECK (max_requests BETWEEN 1 AND 1000000)
);

COMMIT;
