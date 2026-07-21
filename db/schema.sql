BEGIN;

CREATE TABLE issuances (
    jti TEXT PRIMARY KEY,
    agent_id TEXT NOT NULL,
    principal TEXT NOT NULL,
    scope TEXT[] NOT NULL,
    audience TEXT NOT NULL,
    issued_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    expires_at TIMESTAMPTZ NOT NULL,
    delegation_chain JSONB NOT NULL DEFAULT '[]'::jsonb,
    CONSTRAINT issuances_scope_not_empty CHECK (cardinality(scope) > 0),
    CONSTRAINT issuances_expiry_after_issue CHECK (expires_at > issued_at),
    CONSTRAINT issuances_delegation_chain_is_array
        CHECK (jsonb_typeof(delegation_chain) = 'array')
);

CREATE TABLE revocations (
    jti TEXT PRIMARY KEY REFERENCES issuances(jti) ON DELETE CASCADE,
    revoked_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    reason TEXT
);

CREATE TABLE rate_limit_policies (
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

CREATE TABLE verification_log (
    id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    jti TEXT,
    principal TEXT,
    requested_action TEXT NOT NULL,
    audience TEXT NOT NULL,
    decision TEXT NOT NULL,
    denial_reason TEXT,
    verified_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
    CONSTRAINT verification_log_decision_valid
        CHECK (decision IN ('allow', 'deny', 'deny_rate_limited')),
    CONSTRAINT verification_log_denial_reason_consistent
        CHECK (
            (decision = 'allow' AND denial_reason IS NULL)
            OR (decision <> 'allow' AND denial_reason IS NOT NULL)
        ),
    CONSTRAINT verification_log_metadata_is_object
        CHECK (jsonb_typeof(metadata) = 'object')
);

CREATE INDEX issuances_principal_idx ON issuances (principal);
CREATE INDEX issuances_expires_at_idx ON issuances (expires_at);
CREATE INDEX revocations_revoked_at_idx ON revocations (revoked_at);
CREATE INDEX verification_log_verified_at_idx ON verification_log (verified_at);
CREATE INDEX verification_log_denials_idx
    ON verification_log (denial_reason, verified_at)
    WHERE decision <> 'allow';

COMMIT;
