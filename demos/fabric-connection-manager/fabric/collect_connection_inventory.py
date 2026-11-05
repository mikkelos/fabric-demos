"""Collector source for a Fabric PySpark notebook; import performs no I/O."""

from datetime import datetime, timezone
from email.utils import parsedate_to_datetime
import math
import random
import re
import time
import uuid
from urllib.parse import urlsplit


BASE = "https://api.fabric.microsoft.com/v1/admin/connections"
SCHEMAS = {
    "collection_runs": (
        "run_id STRING NOT NULL, started_at TIMESTAMP NOT NULL, completed_at TIMESTAMP, "
        "status STRING NOT NULL, connection_count BIGINT NOT NULL, "
        "role_assignment_count BIGINT NOT NULL, owner_lookup_failure_count BIGINT NOT NULL, "
        "request_count BIGINT NOT NULL, error_code STRING"
    ),
    "connection_snapshots": (
        "snapshot_id STRING NOT NULL, run_id STRING NOT NULL, collected_at TIMESTAMP NOT NULL, "
        "connection_id STRING NOT NULL, display_name STRING NOT NULL, "
        "connectivity_type STRING NOT NULL, source_type STRING NOT NULL, gateway_id STRING, "
        "privacy_level STRING, credential_type STRING, connection_encryption STRING, "
        "created_at TIMESTAMP, last_bound_at TIMESTAMP, last_credential_used_at TIMESTAMP, "
        "my_last_bound_at TIMESTAMP, my_last_credential_used_at TIMESTAMP, "
        "owner_lookup_status STRING NOT NULL, owner_lookup_error_code STRING, "
        "owner_lookup_retry_after_seconds BIGINT, endpoint STRING, endpoint_category STRING, "
        "single_sign_on_type STRING, skip_test_connection BOOLEAN, "
        "allow_usage_in_user_controlled_code BOOLEAN, allow_connection_usage_in_gateway BOOLEAN"
    ),
    "connection_role_assignments": (
        "snapshot_assignment_id STRING NOT NULL, run_id STRING NOT NULL, "
        "connection_id STRING NOT NULL, assignment_id STRING NOT NULL, "
        "principal_id STRING NOT NULL, principal_type STRING NOT NULL, "
        "principal_display_name STRING, role STRING NOT NULL, collected_at TIMESTAMP NOT NULL"
    ),
}

SNAPSHOT_ADDITIONS = {
    "endpoint": "STRING",
    "endpoint_category": "STRING",
    "single_sign_on_type": "STRING",
    "skip_test_connection": "BOOLEAN",
    "allow_usage_in_user_controlled_code": "BOOLEAN",
    "allow_connection_usage_in_gateway": "BOOLEAN",
}


class CollectionError(RuntimeError):
    def __init__(self, code, retry_after=None):
        super().__init__(f"Inventory collection failed: {code}")
        self.code = code
        self.retry_after = retry_after


def utcnow():
    return datetime.now(timezone.utc)


def text(value):
    return value if isinstance(value, str) and value.strip() else None


def required(value):
    result = text(value)
    if result is None:
        raise CollectionError("invalid-response")
    return result


def identifier(value):
    result = required(value)
    if not re.fullmatch(r"[a-zA-Z0-9-]{1,128}", result):
        raise CollectionError("invalid-response")
    return result


def timestamp(value):
    if not isinstance(value, str):
        return None
    try:
        result = datetime.fromisoformat(value.replace("Z", "+00:00"))
        return result.astimezone(timezone.utc) if result.tzinfo else None
    except ValueError:
        return None


def object_field(value, name):
    field = value.get(name)
    if field is None:
        return {}
    if not isinstance(field, dict):
        raise CollectionError("invalid-response")
    return field


def optional_bool(value):
    return value if isinstance(value, bool) else None


def endpoint_metadata(value):
    """Store HTTP origins only; paths and non-URL connection strings can contain secrets."""
    if not isinstance(value, str) or not value.strip():
        return None, "Not reported"
    if len(value) > 16384 or re.search(r"[\x00-\x20\x7f\\]", value):
        return None, "Not exposed"
    try:
        parsed = urlsplit(value)
        if parsed.scheme.lower() not in ("http", "https"):
            return None, "Non-HTTP"
        host = parsed.hostname
        if not host or "%" in host or not re.fullmatch(r"[a-zA-Z0-9.:\[\]-]+", host):
            return None, "Not exposed"
        host = host.lower().rstrip(".")
        port = parsed.port
    except ValueError:
        return None, "Not exposed"
    authority = f"[{host}]" if ":" in host else host
    if port is not None:
        authority += f":{port}"
    category = "HTTP"
    for suffix, label in (
        (".blob.core.windows.net", "Azure Blob Storage"),
        (".dfs.core.windows.net", "Azure Data Lake Storage"),
        (".database.windows.net", "Azure SQL"),
        (".sharepoint.com", "SharePoint"),
        (".crm.dynamics.com", "Dataverse"),
        (".kusto.windows.net", "Azure Data Explorer"),
        (".fabric.microsoft.com", "Microsoft Fabric"),
    ):
        if host.endswith(suffix):
            category = label
            break
    return f"{parsed.scheme.lower()}://{authority}", category


def upgrade_snapshot_schema(spark, actual):
    names = {field.name for field in actual}
    missing = [f"{name} {kind}" for name, kind in SNAPSHOT_ADDITIONS.items() if name not in names]
    if missing:
        spark.sql(f"ALTER TABLE inventory.connection_snapshots ADD COLUMNS ({', '.join(missing)})")
        return spark.table("inventory.connection_snapshots").schema
    return actual


class AdminApi:
    def __init__(self, get, get_token, sleep=time.sleep, clock=time.monotonic,
                 now=utcnow, jitter=random.random, interval=1.0,
                 max_requests=250_000, max_retries=5):
        if not math.isfinite(interval) or interval < 0 or max_requests < 1 or max_retries < 0:
            raise ValueError("Invalid collector request configuration")
        self.get = get
        self.get_token = get_token
        self.sleep = sleep
        self.clock = clock
        self.now = now
        self.jitter = jitter
        self.interval = interval
        self.max_requests = max_requests
        self.max_retries = max_retries
        self.request_count = 0
        self.next_request = 0.0

    def retry_after(self, value):
        if not value:
            return None
        try:
            seconds = float(value) if value.isdigit() else (
                parsedate_to_datetime(value) - self.now()
            ).total_seconds()
            return min(2_147_483_647, math.ceil(max(0, seconds))) if math.isfinite(seconds) else None
        except (ValueError, TypeError, OverflowError):
            return None

    def page(self, connection_id=None, continuation=""):
        url = BASE
        if connection_id is not None:
            url += f"/{identifier(connection_id)}/roleAssignments"
        refreshed = False
        token = required(self.get_token())
        for attempt in range(self.max_retries + 2):
            if self.request_count >= self.max_requests:
                raise CollectionError("request-limit")
            self.sleep(max(0, self.next_request - self.clock()))
            self.next_request = self.clock() + self.interval
            self.request_count += 1
            response = None
            try:
                response = self.get(
                    url, headers={"Authorization": f"Bearer {token}", "Accept": "application/json"},
                    params={"continuationToken": continuation} if continuation else {},
                    timeout=30, allow_redirects=False,
                )
            except TimeoutError:
                code = "timeout"
            except ConnectionError:
                code = "unavailable"
            else:
                status = response.status_code
                if status == 200:
                    try:
                        body = response.json()
                    except ValueError:
                        raise CollectionError("invalid-response") from None
                    if not isinstance(body, dict) or not isinstance(body.get("value"), list):
                        raise CollectionError("invalid-response")
                    return body
                if status == 401:
                    if not refreshed:
                        refreshed = True
                        token = required(self.get_token())
                        continue
                    raise CollectionError("authentication")
                if status == 403:
                    raise CollectionError("permission")
                if status not in (408, 429, 500, 502, 503, 504):
                    raise CollectionError("unavailable")
                code = "rate-limit" if status == 429 else "unavailable"
            delay = self.retry_after(response.headers.get("Retry-After")) if response is not None else None
            if attempt >= self.max_retries:
                raise CollectionError(code, delay)
            # A long server delay fails explicitly instead of retrying prematurely.
            if delay is not None and delay > 300:
                raise CollectionError(code, delay)
            self.sleep(delay if delay is not None else min(60, 2 ** attempt) + self.jitter())
        raise CollectionError("authentication")

    def pages(self, connection_id=None, max_pages=1000):
        continuation = ""
        seen = set()
        for _ in range(max_pages):
            body = self.page(connection_id, continuation)
            if len(body["value"]) > 10_000:
                raise CollectionError("invalid-response")
            yield body["value"]
            next_token = body.get("continuationToken")
            if next_token is None or next_token == "":
                return
            if not isinstance(next_token, str) or len(next_token) > 8192 or next_token in seen:
                raise CollectionError("invalid-response")
            seen.add(next_token)
            continuation = next_token
        raise CollectionError("page-limit")


def connection_row(raw, run_id, collected_at):
    if not isinstance(raw, dict):
        raise CollectionError("invalid-response")
    connection_id = identifier(raw.get("id"))
    details = object_field(raw, "connectionDetails")
    credentials = object_field(raw, "credentialDetails")
    recency = object_field(raw, "connectionRecency")
    endpoint, endpoint_category = endpoint_metadata(details.get("path"))
    return {
        "snapshot_id": f"{run_id}:{connection_id}", "run_id": run_id,
        "collected_at": collected_at, "connection_id": connection_id,
        "display_name": text(raw.get("displayName")) or "Unnamed connection",
        "connectivity_type": required(raw.get("connectivityType")),
        "source_type": text(details.get("type")) or "Unknown", "gateway_id": text(raw.get("gatewayId")),
        "privacy_level": text(raw.get("privacyLevel")),
        "credential_type": text(credentials.get("credentialType")),
        "connection_encryption": text(credentials.get("connectionEncryption")),
        "created_at": timestamp(recency.get("createdDateTime")),
        "last_bound_at": timestamp(recency.get("lastBoundDateTime")),
        "last_credential_used_at": timestamp(recency.get("lastCredentialUsedDateTime")),
        "my_last_bound_at": timestamp(recency.get("myLastBoundDateTime")),
        "my_last_credential_used_at": timestamp(recency.get("myLastCredentialUsedDateTime")),
        "owner_lookup_status": "complete", "owner_lookup_error_code": None,
        "owner_lookup_retry_after_seconds": None,
        "endpoint": endpoint, "endpoint_category": endpoint_category,
        "single_sign_on_type": text(credentials.get("singleSignOnType")),
        "skip_test_connection": optional_bool(credentials.get("skipTestConnection")),
        "allow_usage_in_user_controlled_code": optional_bool(raw.get("allowUsageInUserControlledCode")),
        "allow_connection_usage_in_gateway": optional_bool(raw.get("allowConnectionUsageInGateway")),
    }


def role_rows(api, connection_id, run_id, collected_at):
    rows = []
    seen = set()
    for page in api.pages(connection_id, max_pages=100):
        for raw in page:
            if not isinstance(raw, dict):
                raise CollectionError("invalid-response")
            assignment_id = identifier(raw.get("id"))
            if assignment_id in seen or len(rows) >= 10_000:
                raise CollectionError("invalid-response")
            seen.add(assignment_id)
            principal = object_field(raw, "principal")
            rows.append({
                "snapshot_assignment_id": f"{run_id}:{connection_id}:{assignment_id}",
                "run_id": run_id, "connection_id": connection_id, "assignment_id": assignment_id,
                "principal_id": required(principal.get("id")),
                "principal_type": required(principal.get("type")),
                "principal_display_name": text(principal.get("displayName")),
                "role": required(raw.get("role")), "collected_at": collected_at,
            })
    return rows


def collect(api, sink, now=utcnow, max_connections=100_000, max_assignments=200_000):
    run = {
        "run_id": str(uuid.uuid4()), "started_at": now(), "completed_at": None,
        "status": "collecting", "connection_count": 0, "role_assignment_count": 0,
        "owner_lookup_failure_count": 0, "request_count": 0, "error_code": None,
    }
    sink.begin(run.copy())
    seen = set()
    try:
        for page in api.pages():
            for raw in page:
                row = connection_row(raw, run["run_id"], now())
                connection_id = row["connection_id"]
                if connection_id in seen or len(seen) >= max_connections:
                    raise CollectionError("connection-limit-or-duplicate")
                seen.add(connection_id)
                try:
                    roles = role_rows(api, connection_id, run["run_id"], row["collected_at"])
                except CollectionError as error:
                    if error.code not in ("permission", "rate-limit", "timeout", "unavailable", "invalid-response"):
                        raise
                    roles = []
                    row.update(owner_lookup_status="failed", owner_lookup_error_code=error.code,
                               owner_lookup_retry_after_seconds=error.retry_after)
                    run["owner_lookup_failure_count"] += 1
                if run["role_assignment_count"] + len(roles) > max_assignments:
                    raise CollectionError("assignment-limit")
                sink.append("connection_role_assignments", roles)
                sink.append("connection_snapshots", [row])
                run["connection_count"] += 1
                run["role_assignment_count"] += len(roles)
        sink.flush()
        run.update(status="complete", completed_at=now(), request_count=api.request_count)
        sink.finish(run.copy())
        return run
    except Exception as error:
        run.update(status="failed", completed_at=now(), request_count=api.request_count,
                   error_code=error.code if isinstance(error, CollectionError) else "collector-or-write-failure")
        sink.finish(run.copy())
        raise


class SparkSink:
    def __init__(self, spark, context, batch_size=500):
        if context.get("defaultLakehouseName") != "lh_connection_inventory":
            raise CollectionError("wrong-default-lakehouse")
        if batch_size < 1:
            raise ValueError("Invalid batch size")
        self.spark = spark
        self.batch_size = batch_size
        self.buffers = {"connection_snapshots": [], "connection_role_assignments": []}
        self.schemas = {}
        spark.conf.set("spark.sql.session.timeZone", "UTC")
        for name, ddl in SCHEMAS.items():
            expected = spark.createDataFrame([], ddl).schema
            actual = spark.table(f"inventory.{name}").schema
            if name == "connection_snapshots":
                actual = upgrade_snapshot_schema(spark, actual)
            # SQL/Delta may relax nullability; names, order, and types must match.
            if [(f.name, f.dataType) for f in expected] != [(f.name, f.dataType) for f in actual]:
                raise CollectionError("incompatible-target-schema")
            self.schemas[name] = expected

    def write(self, table, rows):
        if rows:
            self.spark.createDataFrame(rows, self.schemas[table]).write.format("delta").mode(
                "append"
            ).saveAsTable(f"inventory.{table}")

    def begin(self, run):
        self.write("collection_runs", [run])

    def append(self, table, rows):
        for row in rows:
            self.buffers[table].append(row)
            if len(self.buffers[table]) >= self.batch_size:
                self.write(table, self.buffers[table])
                self.buffers[table] = []

    def flush(self):
        for table, rows in self.buffers.items():
            self.write(table, rows)
            self.buffers[table] = []

    def finish(self, run):
        from delta.tables import DeltaTable
        frame = self.spark.createDataFrame([run], self.schemas["collection_runs"])
        DeltaTable.forName(self.spark, "inventory.collection_runs").alias("target").merge(
            frame.alias("source"), "target.run_id = source.run_id"
        ).whenMatchedUpdateAll().execute()


def run_notebook(spark, notebookutils):
    import requests
    with requests.Session() as session:
        def get(*args, **kwargs):
            try:
                return session.get(*args, **kwargs)
            except requests.Timeout:
                raise TimeoutError("Fabric request timed out") from None
            except requests.ConnectionError:
                raise ConnectionError("Fabric request failed") from None

        sink = SparkSink(spark, notebookutils.runtime.context)
        api = AdminApi(get, lambda: notebookutils.credentials.getToken("pbi"))
        result = collect(api, sink)
        print({key: result[key] for key in (
            "run_id", "status", "connection_count", "role_assignment_count",
            "owner_lookup_failure_count", "request_count",
        )})
        return result
