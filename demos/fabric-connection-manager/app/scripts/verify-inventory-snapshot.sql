WITH latest AS (
    SELECT TOP (1) run_id, started_at, completed_at, connection_count,
        role_assignment_count, owner_lookup_failure_count
    FROM inventory.collection_runs
    WHERE status = 'complete'
    ORDER BY started_at DESC, run_id DESC
)
SELECT r.started_at, r.completed_at,
    r.connection_count AS expected_connections,
    r.role_assignment_count AS expected_assignments,
    r.owner_lookup_failure_count AS expected_lookup_failures,
    (SELECT COUNT_BIG(*) FROM inventory.connection_snapshots c
        WHERE c.run_id = r.run_id) AS actual_connections,
    (SELECT COUNT_BIG(DISTINCT c.connection_id) FROM inventory.connection_snapshots c
        WHERE c.run_id = r.run_id) AS unique_connections,
    (SELECT COUNT_BIG(*) FROM inventory.connection_role_assignments a
        WHERE a.run_id = r.run_id) AS actual_assignments,
    (SELECT COUNT_BIG(DISTINCT a.snapshot_assignment_id) FROM inventory.connection_role_assignments a
        WHERE a.run_id = r.run_id) AS unique_assignments,
    (SELECT COUNT_BIG(*) FROM inventory.connection_snapshots c
        WHERE c.run_id = r.run_id AND c.owner_lookup_status = 'failed') AS actual_lookup_failures,
    (SELECT COUNT_BIG(*) FROM inventory.connection_role_assignments a
        LEFT JOIN inventory.connection_snapshots c
            ON c.run_id = a.run_id AND c.connection_id = a.connection_id
        WHERE a.run_id = r.run_id AND c.connection_id IS NULL) AS orphaned_assignments,
    (SELECT COUNT_BIG(*) FROM inventory.connection_snapshots c
        WHERE c.run_id = r.run_id AND c.endpoint IS NOT NULL) AS connections_with_endpoint_origin,
    (SELECT COUNT_BIG(*) FROM inventory.connection_snapshots c
        WHERE c.run_id = r.run_id AND c.endpoint_category IS NOT NULL) AS connections_with_endpoint_category,
    (SELECT COUNT_BIG(*) FROM inventory.connection_snapshots c
        WHERE c.run_id = r.run_id AND c.single_sign_on_type IS NOT NULL) AS connections_with_sso_metadata,
    (SELECT COUNT_BIG(*) FROM inventory.connection_snapshots c
        WHERE c.run_id = r.run_id AND c.endpoint IS NOT NULL
            AND (c.endpoint LIKE '%?%' OR c.endpoint LIKE '%#%' OR c.endpoint LIKE '%@%'
                OR CHARINDEX('/', c.endpoint, CHARINDEX('://', c.endpoint) + 3) > 0
                OR (c.endpoint NOT LIKE 'https://%' AND c.endpoint NOT LIKE 'http://%')))
        AS unsafe_endpoint_origins
FROM latest r
OPTION (LABEL = 'CONNECTION_INVENTORY_VERIFY');
