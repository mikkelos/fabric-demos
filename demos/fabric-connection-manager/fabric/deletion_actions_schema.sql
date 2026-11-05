IF SCHEMA_ID('operations') IS NULL EXEC('CREATE SCHEMA operations');
GO

IF OBJECT_ID('operations.deletion_requests', 'U') IS NULL
BEGIN
    CREATE TABLE operations.deletion_requests (
        request_id UNIQUEIDENTIFIER NOT NULL DEFAULT NEWSEQUENTIALID() PRIMARY KEY,
        batch_id UNIQUEIDENTIFIER NOT NULL,
        connection_id UNIQUEIDENTIFIER NOT NULL,
        snapshot_run_id UNIQUEIDENTIFIER NOT NULL,
        requested_by NVARCHAR(2048) COLLATE Latin1_General_100_BIN2 NOT NULL,
        requested_at DATETIME2(7) NOT NULL DEFAULT SYSUTCDATETIME(),
        connection_name NVARCHAR(1000) NOT NULL,
        baseline_json NVARCHAR(MAX) NOT NULL CHECK (ISJSON(baseline_json) = 1),
        baseline_hash VARBINARY(32) NOT NULL,
        status VARCHAR(24) NOT NULL DEFAULT 'pending'
            CHECK (status IN ('pending', 'processing', 'reconcile', 'deleted', 'cancelled')),
        claim_owner NVARCHAR(200) NULL,
        delete_attempted BIT NOT NULL DEFAULT 0,
        row_version ROWVERSION NOT NULL,
        CONSTRAINT uq_deletion_batch_connection UNIQUE (batch_id, connection_id)
    );
    CREATE INDEX ix_deletion_requests_status ON operations.deletion_requests(status, requested_at);
END;
GO

IF COL_LENGTH('operations.deletion_requests', 'requested_by') BETWEEN 1 AND 4095
    ALTER TABLE operations.deletion_requests
        ALTER COLUMN requested_by NVARCHAR(2048) COLLATE Latin1_General_100_BIN2 NOT NULL;
GO

IF NOT EXISTS (SELECT 1 FROM sys.indexes
    WHERE object_id = OBJECT_ID('operations.deletion_requests') AND name = 'ix_deletion_requests_connection')
    CREATE INDEX ix_deletion_requests_connection
        ON operations.deletion_requests(connection_id, status) INCLUDE (batch_id);
GO

IF OBJECT_ID('operations.deletion_events', 'U') IS NULL
BEGIN
    CREATE TABLE operations.deletion_events (
        event_id BIGINT IDENTITY(1, 1) NOT NULL PRIMARY KEY,
        request_id UNIQUEIDENTIFIER NOT NULL REFERENCES operations.deletion_requests(request_id),
        event_sequence TINYINT NOT NULL,
        event_type VARCHAR(30) NOT NULL,
        event_at DATETIME2(7) NOT NULL DEFAULT SYSUTCDATETIME(),
        actor_kind VARCHAR(20) NOT NULL CHECK (actor_kind IN ('rayfin_subject', 'notebook')),
        actor_id NVARCHAR(2048) NOT NULL,
        reason NVARCHAR(200) NULL,
        api_status SMALLINT NULL CHECK (api_status BETWEEN 100 AND 599),
        api_request_id NVARCHAR(200) NULL,
        worker_run_id NVARCHAR(200) NULL,
        CONSTRAINT uq_deletion_event_sequence UNIQUE (request_id, event_sequence),
        CONSTRAINT ck_deletion_event_sequence CHECK (
            (event_sequence = 0 AND event_type = 'marked_for_deletion')
            OR (event_sequence = 1 AND event_type IN ('deleted', 'deletion_cancelled'))
        )
    );
END;
GO

IF COL_LENGTH('operations.deletion_events', 'actor_id') BETWEEN 1 AND 4095
    ALTER TABLE operations.deletion_events ALTER COLUMN actor_id NVARCHAR(2048) NOT NULL;
GO

CREATE OR ALTER PROCEDURE operations.LogDeletionRequests
    @BatchId UNIQUEIDENTIFIER,
    @SnapshotRunId UNIQUEIDENTIFIER,
    @RequestedBy NVARCHAR(2048),
    @ConnectionsJson NVARCHAR(MAX)
AS
BEGIN
    SET NOCOUNT ON;
    SET XACT_ABORT ON;
    IF @BatchId IS NULL OR @SnapshotRunId IS NULL OR NULLIF(TRIM(@RequestedBy), '') IS NULL
        THROW 50001, 'Invalid request identities.', 1;
    IF ISJSON(@ConnectionsJson) <> 1 OR LEFT(LTRIM(@ConnectionsJson), 1) <> '['
        THROW 50001, 'Expected a connection array.', 1;
    DECLARE @Count INT = (SELECT COUNT(*) FROM OPENJSON(@ConnectionsJson));
    IF @Count < 1 OR @Count > 500
        THROW 50001, 'Expected between 1 and 500 connections.', 1;
    IF EXISTS (
        SELECT 1 FROM OPENJSON(@ConnectionsJson) items
        WHERE items.type <> 5
            OR TRY_CONVERT(UNIQUEIDENTIFIER, JSON_VALUE(items.value, '$.connectionId')) IS NULL
            OR JSON_VALUE(items.value, '$.displayName') IS NULL
            OR LEN(JSON_VALUE(items.value, '$.displayName')) > 1000
            OR JSON_VALUE(items.value, '$.connectivityType') IS NULL
            OR JSON_VALUE(items.value, '$.sourceType') IS NULL
            OR (SELECT COUNT(*) FROM OPENJSON(items.value)) <> 7
            OR EXISTS (
                SELECT 1 FROM OPENJSON(items.value) fields
                WHERE fields.[key] NOT IN (
                    'connectionId', 'displayName', 'connectivityType', 'sourceType',
                    'createdAt', 'lastBoundAt', 'lastCredentialUsedAt'
                )
            )
    ) THROW 50001, 'Invalid connection baseline.', 1;

    DECLARE @Incoming TABLE (
        connection_id UNIQUEIDENTIFIER NOT NULL PRIMARY KEY,
        connection_name NVARCHAR(1000) NOT NULL,
        baseline_json NVARCHAR(MAX) NOT NULL,
        baseline_hash VARBINARY(32) NOT NULL
    );
    IF (SELECT COUNT(DISTINCT TRY_CONVERT(UNIQUEIDENTIFIER, JSON_VALUE(value, '$.connectionId')))
        FROM OPENJSON(@ConnectionsJson)) <> @Count
        THROW 50001, 'Duplicate connection identity.', 1;
    INSERT @Incoming
        SELECT CONVERT(UNIQUEIDENTIFIER, JSON_VALUE(value, '$.connectionId')),
            JSON_VALUE(value, '$.displayName'), value, HASHBYTES('SHA2_256', value)
        FROM OPENJSON(@ConnectionsJson);

    BEGIN TRANSACTION;
    DECLARE @LockResult INT, @LockResource NVARCHAR(255) = CONCAT('deletion-batch:', @BatchId);
    EXEC @LockResult = sys.sp_getapplock @Resource = @LockResource,
        @LockMode = 'Exclusive', @LockOwner = 'Transaction', @LockTimeout = 10000;
    IF @LockResult < 0 THROW 50002, 'Deletion request is busy; retry with the same identity.', 1;
    EXEC @LockResult = sys.sp_getapplock @Resource = 'deletion-events',
        @LockMode = 'Exclusive', @LockOwner = 'Transaction', @LockTimeout = 10000;
    IF @LockResult < 0 THROW 50002, 'Deletion events are busy; retry.', 1;
    IF EXISTS (
        SELECT 1 FROM operations.deletion_requests
        WHERE batch_id = @BatchId
            AND (requested_by <> @RequestedBy OR snapshot_run_id <> @SnapshotRunId)
    ) THROW 50003, 'Request identity conflicts with an existing submission.', 1;
    IF EXISTS (
        SELECT 1 FROM operations.deletion_requests stored
        JOIN @Incoming incoming ON incoming.connection_id = stored.connection_id
        WHERE stored.batch_id = @BatchId AND stored.baseline_hash <> incoming.baseline_hash
    ) THROW 50003, 'Request baseline conflicts with an existing submission.', 1;
    IF EXISTS (
        SELECT 1 FROM @Incoming incoming
        JOIN operations.deletion_requests stored WITH (UPDLOCK, HOLDLOCK, INDEX(ix_deletion_requests_connection))
            ON stored.connection_id = incoming.connection_id
        WHERE stored.batch_id <> @BatchId AND stored.status <> 'cancelled'
            AND NOT EXISTS (
                SELECT 1 FROM operations.deletion_requests retry
                WHERE retry.batch_id = @BatchId AND retry.connection_id = incoming.connection_id
            )
    ) THROW 50006, 'A connection already has an active or deleted request.', 1;

    DECLARE @Added TABLE (request_id UNIQUEIDENTIFIER NOT NULL);
    INSERT operations.deletion_requests
        (batch_id, connection_id, snapshot_run_id, requested_by, connection_name, baseline_json, baseline_hash)
    OUTPUT inserted.request_id INTO @Added
        SELECT @BatchId, incoming.connection_id, @SnapshotRunId, @RequestedBy,
            incoming.connection_name, incoming.baseline_json, incoming.baseline_hash
        FROM @Incoming incoming
        WHERE NOT EXISTS (
            SELECT 1 FROM operations.deletion_requests stored
            WHERE stored.batch_id = @BatchId AND stored.connection_id = incoming.connection_id
        );
    INSERT operations.deletion_events (request_id, event_sequence, event_type, actor_kind, actor_id)
        SELECT request_id, 0, 'marked_for_deletion', 'rayfin_subject', @RequestedBy FROM @Added;
    COMMIT TRANSACTION;
    SELECT @Count AS marked_count;
END;
GO

CREATE OR ALTER PROCEDURE operations.RecordDeletionOutcome
    @RequestId UNIQUEIDENTIFIER,
    @EventType VARCHAR(30),
    @WorkerRunId NVARCHAR(200),
    @Reason NVARCHAR(200),
    @ApiStatus SMALLINT = NULL,
    @ApiRequestId NVARCHAR(200) = NULL
AS
BEGIN
    SET NOCOUNT ON;
    SET XACT_ABORT ON;
    IF @EventType IS NULL OR @EventType NOT IN ('deleted', 'deletion_cancelled')
        OR NULLIF(TRIM(@WorkerRunId), '') IS NULL OR NULLIF(TRIM(@Reason), '') IS NULL
        THROW 50001, 'Invalid notebook outcome.', 1;
    BEGIN TRANSACTION;
    DECLARE @LockResult INT;
    EXEC @LockResult = sys.sp_getapplock @Resource = 'deletion-events',
        @LockMode = 'Exclusive', @LockOwner = 'Transaction', @LockTimeout = 10000;
    IF @LockResult < 0 THROW 50002, 'Deletion events are busy; retry.', 1;
    DECLARE @Status VARCHAR(24), @Attempted BIT, @Owner NVARCHAR(200);
    SELECT @Status = status, @Attempted = delete_attempted, @Owner = claim_owner
        FROM operations.deletion_requests WITH (UPDLOCK, HOLDLOCK) WHERE request_id = @RequestId;
    IF @Status IS NULL THROW 50004, 'Deletion request does not exist.', 1;
    IF @Status IN ('deleted', 'cancelled')
    BEGIN
        IF NOT EXISTS (
            SELECT 1 FROM operations.deletion_events
            WHERE request_id = @RequestId AND event_sequence = 1 AND event_type = @EventType
                AND worker_run_id = @WorkerRunId AND reason = @Reason
                AND (api_status = @ApiStatus OR (api_status IS NULL AND @ApiStatus IS NULL))
                AND (api_request_id = @ApiRequestId OR (api_request_id IS NULL AND @ApiRequestId IS NULL))
        ) THROW 50003, 'A different terminal outcome is already recorded.', 1;
        COMMIT TRANSACTION;
        RETURN;
    END;
    IF @Status <> 'pending' AND (@Owner IS NULL OR @Owner <> @WorkerRunId)
        THROW 50005, 'Notebook does not own the request claim.', 1;
    IF @EventType = 'deleted' AND (@Attempted <> 1 OR @Status NOT IN ('processing', 'reconcile'))
        THROW 50005, 'A verified deletion attempt is required.', 1;
    UPDATE operations.deletion_requests
        SET status = CASE WHEN @EventType = 'deleted' THEN 'deleted' ELSE 'cancelled' END,
            claim_owner = NULL WHERE request_id = @RequestId;
    INSERT operations.deletion_events
        (request_id, event_sequence, event_type, actor_kind, actor_id, reason, api_status, api_request_id, worker_run_id)
        VALUES (@RequestId, 1, @EventType, 'notebook', @WorkerRunId, @Reason, @ApiStatus, @ApiRequestId, @WorkerRunId);
    COMMIT TRANSACTION;
END;
GO

CREATE OR ALTER PROCEDURE operations.CancelDeletionRequests
    @RequestedBy NVARCHAR(2048),
    @RequestIdsJson NVARCHAR(MAX)
AS
BEGIN
    SET NOCOUNT ON;
    SET XACT_ABORT ON;
    IF NULLIF(TRIM(@RequestedBy), '') IS NULL OR ISJSON(@RequestIdsJson) <> 1
        OR LEFT(LTRIM(@RequestIdsJson), 1) <> '['
        THROW 50001, 'Invalid cancellation input.', 1;
    DECLARE @Count INT = (SELECT COUNT(*) FROM OPENJSON(@RequestIdsJson));
    IF @Count < 1 OR @Count > 500 OR EXISTS (
        SELECT 1 FROM OPENJSON(@RequestIdsJson)
        WHERE type <> 1 OR LEN(value) <> 36 OR TRY_CONVERT(UNIQUEIDENTIFIER, value) IS NULL
            OR TRY_CONVERT(UNIQUEIDENTIFIER, value) = '00000000-0000-0000-0000-000000000000'
    ) THROW 50001, 'Expected between 1 and 500 unique request identities.', 1;
    IF (SELECT COUNT(DISTINCT TRY_CONVERT(UNIQUEIDENTIFIER, value)) FROM OPENJSON(@RequestIdsJson)) <> @Count
        THROW 50001, 'Duplicate cancellation identity.', 1;
    DECLARE @Ids TABLE (request_id UNIQUEIDENTIFIER NOT NULL PRIMARY KEY);
    INSERT @Ids SELECT CONVERT(UNIQUEIDENTIFIER, value) FROM OPENJSON(@RequestIdsJson);

    BEGIN TRANSACTION;
    DECLARE @LockResult INT;
    EXEC @LockResult = sys.sp_getapplock @Resource = 'deletion-events',
        @LockMode = 'Exclusive', @LockOwner = 'Transaction', @LockTimeout = 10000;
    IF @LockResult < 0 THROW 50002, 'Deletion events are busy; retry.', 1;
    DECLARE @Locked TABLE (
        request_id UNIQUEIDENTIFIER NOT NULL PRIMARY KEY,
        status VARCHAR(24) NOT NULL,
        delete_attempted BIT NOT NULL,
        claim_owner NVARCHAR(200) NULL
    );
    INSERT @Locked
        SELECT r.request_id, r.status, r.delete_attempted, r.claim_owner
        FROM operations.deletion_requests r WITH (UPDLOCK, HOLDLOCK)
        JOIN @Ids i ON i.request_id = r.request_id;
    IF (SELECT COUNT(*) FROM @Locked) <> @Count
        THROW 50005, 'Cancellation requires existing eligible requests.', 1;
    IF EXISTS (
        SELECT 1 FROM @Locked r
        WHERE NOT (
            (r.status = 'pending' AND r.delete_attempted = 0 AND r.claim_owner IS NULL
                AND NOT EXISTS (
                    SELECT 1 FROM operations.deletion_events e
                    WHERE e.request_id = r.request_id AND e.event_sequence = 1
                ))
            OR (r.status = 'cancelled' AND EXISTS (
                SELECT 1 FROM operations.deletion_events e
                WHERE e.request_id = r.request_id AND e.event_sequence = 1
                    AND e.event_type = 'deletion_cancelled' AND e.actor_kind = 'rayfin_subject'
                    AND e.reason = 'user_cancelled' AND e.actor_id COLLATE Latin1_General_100_BIN2
                        = @RequestedBy COLLATE Latin1_General_100_BIN2
            ))
        )
    ) THROW 50005, 'A request is no longer eligible for user cancellation.', 1;

    DECLARE @Cancelled TABLE (request_id UNIQUEIDENTIFIER NOT NULL PRIMARY KEY);
    UPDATE r SET status = 'cancelled', claim_owner = NULL
        OUTPUT inserted.request_id INTO @Cancelled
        FROM operations.deletion_requests r
        JOIN @Locked locked ON locked.request_id = r.request_id
        WHERE locked.status = 'pending';
    INSERT operations.deletion_events
        (request_id, event_sequence, event_type, actor_kind, actor_id, reason)
        SELECT request_id, 1, 'deletion_cancelled', 'rayfin_subject', @RequestedBy, 'user_cancelled'
        FROM @Cancelled;
    COMMIT TRANSACTION;
    SELECT @Count AS cancelled_count;
END;
GO

CREATE OR ALTER PROCEDURE operations.GetDeletionActions
    @AfterId UNIQUEIDENTIFIER = NULL,
    @Watermark BIGINT = NULL
AS
BEGIN
    SET NOCOUNT ON;
    SET XACT_ABORT ON;
    IF @Watermark < 0 OR (@AfterId IS NOT NULL AND @Watermark IS NULL)
        THROW 50001, 'Invalid action pagination.', 1;
    BEGIN TRANSACTION;
    DECLARE @LockResult INT, @Latest BIGINT;
    -- Serialize the cut with event writers so an uncommitted lower identity cannot appear on a later page.
    EXEC @LockResult = sys.sp_getapplock @Resource = 'deletion-events',
        @LockMode = 'Shared', @LockOwner = 'Transaction', @LockTimeout = 10000;
    IF @LockResult < 0 THROW 50002, 'Deletion events are busy; retry.', 1;
    SELECT @Latest = COALESCE(MAX(event_id), 0) FROM operations.deletion_events;
    IF @Watermark IS NULL SET @Watermark = @Latest;
    IF @Watermark > @Latest THROW 50001, 'Invalid future action watermark.', 1;

    DECLARE @Visible TABLE (
        request_id UNIQUEIDENTIFIER NOT NULL PRIMARY KEY,
        connection_id UNIQUEIDENTIFIER NOT NULL,
        connection_name NVARCHAR(1000) NOT NULL,
        requested_at DATETIME2(7) NOT NULL,
        deleted_at DATETIME2(7) NULL,
        state_rank INT NOT NULL,
        eligible BIT NOT NULL
    );
    INSERT @Visible
        SELECT r.request_id, r.connection_id, r.connection_name, r.requested_at,
            CASE WHEN terminal.event_type = 'deleted' THEN terminal.event_at END,
            CASE WHEN terminal.event_type = 'deleted' THEN 1
                WHEN terminal.event_type = 'deletion_cancelled' THEN 5
                WHEN r.status = 'processing' THEN 2
                WHEN r.status = 'reconcile' OR r.delete_attempted = 1 THEN 3
                WHEN r.claim_owner IS NOT NULL THEN 2
                ELSE 4 END,
            CASE WHEN terminal.event_id IS NULL AND r.status = 'pending'
                AND r.claim_owner IS NULL AND r.delete_attempted = 0 THEN 1 ELSE 0 END
        FROM operations.deletion_requests r WITH (HOLDLOCK)
        JOIN operations.deletion_events marked
            ON marked.request_id = r.request_id AND marked.event_sequence = 0 AND marked.event_id <= @Watermark
        LEFT JOIN operations.deletion_events terminal
            ON terminal.request_id = r.request_id AND terminal.event_sequence = 1 AND terminal.event_id <= @Watermark;

    DECLARE @Page TABLE (
        connection_id UNIQUEIDENTIFIER NOT NULL PRIMARY KEY,
        state_rank INT NOT NULL,
        requested_at DATETIME2(7) NOT NULL,
        deleted_at DATETIME2(7) NULL
    );
    INSERT @Page
        SELECT TOP (501) connection_id, MIN(state_rank), MAX(requested_at), MAX(deleted_at)
        FROM @Visible
        WHERE @AfterId IS NULL OR connection_id > @AfterId
        GROUP BY connection_id ORDER BY connection_id;
    DECLARE @HasMore BIT = CASE WHEN (SELECT COUNT(*) FROM @Page) > 500 THEN 1 ELSE 0 END;
    IF @HasMore = 1 DELETE FROM @Page WHERE connection_id = (SELECT TOP (1) connection_id FROM @Page ORDER BY connection_id DESC);
    DECLARE @Next UNIQUEIDENTIFIER;
    IF @HasMore = 1 SELECT TOP (1) @Next = connection_id FROM @Page ORDER BY connection_id DESC;

    SELECT CONVERT(VARCHAR(20), @Watermark) AS watermark, CONVERT(VARCHAR(36), @Next) AS next_cursor;
    SELECT CONVERT(VARCHAR(36), p.connection_id) AS connection_id,
        (SELECT TOP (1) connection_name FROM @Visible v WHERE v.connection_id = p.connection_id
            ORDER BY requested_at DESC, request_id DESC) AS connection_name,
        CASE p.state_rank WHEN 1 THEN 'deleted' WHEN 2 THEN 'processing'
            WHEN 3 THEN 'reconcile' WHEN 4 THEN 'pending' ELSE 'cancelled' END AS status,
        p.requested_at, p.deleted_at,
        COALESCE((
            SELECT '[' + STRING_AGG(CONVERT(NVARCHAR(MAX), '"' + CONVERT(VARCHAR(36), v.request_id) + '"'), ',') + ']'
            FROM @Visible v WHERE v.connection_id = p.connection_id AND v.eligible = 1 AND p.state_rank = 4
        ), '[]') AS pending_request_ids_json
    FROM @Page p ORDER BY p.connection_id;
    COMMIT TRANSACTION;
END;
GO

IF DATABASE_PRINCIPAL_ID('connection_action_submitter') IS NULL
    CREATE ROLE connection_action_submitter;
IF DATABASE_PRINCIPAL_ID('connection_action_processor') IS NULL
    CREATE ROLE connection_action_processor;
GRANT EXECUTE ON operations.LogDeletionRequests TO connection_action_submitter;
GRANT EXECUTE ON operations.GetDeletionActions TO connection_action_submitter;
GRANT EXECUTE ON operations.CancelDeletionRequests TO connection_action_submitter;
DENY INSERT, UPDATE, DELETE ON operations.deletion_requests TO connection_action_submitter;
DENY INSERT, UPDATE, DELETE ON operations.deletion_events TO connection_action_submitter;
GRANT SELECT ON operations.deletion_requests TO connection_action_processor;
GRANT SELECT ON operations.deletion_events TO connection_action_processor;
GRANT UPDATE (status, claim_owner, delete_attempted) ON operations.deletion_requests TO connection_action_processor;
GRANT EXECUTE ON operations.RecordDeletionOutcome TO connection_action_processor;
DENY INSERT, UPDATE, DELETE ON operations.deletion_events TO connection_action_processor;
GO
