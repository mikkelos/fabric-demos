-- Run with the schema-enabled lh_connection_inventory as the default lakehouse.
CREATE SCHEMA IF NOT EXISTS inventory;

CREATE TABLE IF NOT EXISTS inventory.collection_runs (
    run_id STRING NOT NULL,
    started_at TIMESTAMP NOT NULL,
    completed_at TIMESTAMP,
    status STRING NOT NULL,
    connection_count BIGINT NOT NULL,
    role_assignment_count BIGINT NOT NULL,
    owner_lookup_failure_count BIGINT NOT NULL,
    request_count BIGINT NOT NULL,
    error_code STRING
)
USING DELTA;

CREATE TABLE IF NOT EXISTS inventory.connection_snapshots (
    snapshot_id STRING NOT NULL,
    run_id STRING NOT NULL,
    collected_at TIMESTAMP NOT NULL,
    connection_id STRING NOT NULL,
    display_name STRING NOT NULL,
    connectivity_type STRING NOT NULL,
    source_type STRING NOT NULL,
    gateway_id STRING,
    privacy_level STRING,
    credential_type STRING,
    connection_encryption STRING,
    created_at TIMESTAMP,
    last_bound_at TIMESTAMP,
    last_credential_used_at TIMESTAMP,
    my_last_bound_at TIMESTAMP,
    my_last_credential_used_at TIMESTAMP,
    owner_lookup_status STRING NOT NULL,
    owner_lookup_error_code STRING,
    owner_lookup_retry_after_seconds BIGINT,
    endpoint STRING,
    endpoint_category STRING,
    single_sign_on_type STRING,
    skip_test_connection BOOLEAN,
    allow_usage_in_user_controlled_code BOOLEAN,
    allow_connection_usage_in_gateway BOOLEAN
)
USING DELTA;

CREATE TABLE IF NOT EXISTS inventory.connection_role_assignments (
    snapshot_assignment_id STRING NOT NULL,
    run_id STRING NOT NULL,
    connection_id STRING NOT NULL,
    assignment_id STRING NOT NULL,
    principal_id STRING NOT NULL,
    principal_type STRING NOT NULL,
    principal_display_name STRING,
    role STRING NOT NULL,
    collected_at TIMESTAMP NOT NULL
)
USING DELTA;
