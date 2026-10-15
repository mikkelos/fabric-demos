# Fabric notebook source

# METADATA ********************

# META {
# META   "kernel_info": {
# META     "name": "synapse_pyspark"
# META   },
# META   "dependencies": {
# META     "lakehouse": {
# META       "default_lakehouse": "d08e36af-92b4-a2ff-44ac-3efd51345192",
# META       "default_lakehouse_name": "maintenance_lh",
# META       "default_lakehouse_workspace_id": "00000000-0000-0000-0000-000000000000",
# META       "known_lakehouses": [
# META         {
# META           "id": "d08e36af-92b4-a2ff-44ac-3efd51345192",
# META           "workspace_id": "00000000-0000-0000-0000-000000000000"
# META         }
# META       ]
# META     }
# META   }
# META }

# MARKDOWN ********************

# # Validate the maintenance data product
# Read-only post-deployment checks for the synthetic maintenance table: target-local binding, required string columns, five unique nonempty asset IDs, two critical assets, and valid maintenance categories. Any failed check fails the notebook; no data is repaired or written.


# CELL ********************

import notebookutils
from pyspark.sql import functions as F
from pyspark.sql.types import StringType

context = notebookutils.runtime.context
workspace_id = context["currentWorkspaceId"]
lakehouse_id = context["defaultLakehouseId"]

if not workspace_id or not lakehouse_id:
    raise RuntimeError("Validation failed: a workspace and default lakehouse are required.")
if context["defaultLakehouseWorkspaceId"] != workspace_id:
    raise RuntimeError("Validation failed: the lakehouse must belong to the execution workspace.")
if context["defaultLakehouseName"] != "maintenance_lh":
    raise RuntimeError("Validation failed: the default lakehouse must be maintenance_lh.")

print(f"Execution workspace: {context['currentWorkspaceName']} ({workspace_id})")
print(f"Target lakehouse: maintenance_lh ({lakehouse_id})")

table_name = "dbo.demo_maintenance_assets"
if not spark.catalog.tableExists(table_name):
    raise RuntimeError(f"Validation failed: {table_name} does not exist. Run seed_maintenance first.")

assets = spark.table(table_name)
required_columns = {
    "asset_id", "asset_name", "facility", "criticality", "maintenance_status"
}
missing_columns = required_columns - set(assets.columns)
if missing_columns:
    raise RuntimeError(f"Validation failed: missing columns {sorted(missing_columns)}.")
wrong_types = [
    field.name for field in assets.schema.fields
    if field.name in required_columns and not isinstance(field.dataType, StringType)
]
if wrong_types:
    raise RuntimeError(f"Validation failed: columns must be strings: {sorted(wrong_types)}.")

invalid_required = F.lit(False)
for column_name in sorted(required_columns):
    column = F.col(column_name)
    invalid_required = invalid_required | column.isNull() | (F.trim(column) == "")

metrics = assets.agg(
    F.count("*").alias("row_count"),
    F.countDistinct("asset_id").alias("unique_asset_count"),
    F.sum(F.when(F.col("criticality") == "Critical", 1).otherwise(0)).alias("critical_count"),
    F.sum(F.when(invalid_required, 1).otherwise(0)).alias("invalid_required_count"),
    F.sum(F.when(~F.col("criticality").isin("Critical", "Standard"), 1).otherwise(0)).alias("invalid_criticality_count"),
    F.sum(F.when(~F.col("maintenance_status").isin("Overdue", "Scheduled", "Complete"), 1).otherwise(0)).alias("invalid_status_count"),
).first().asDict()

expected = {
    "row_count": 5,
    "unique_asset_count": 5,
    "critical_count": 2,
    "invalid_required_count": 0,
    "invalid_criticality_count": 0,
    "invalid_status_count": 0,
}
failures = [
    f"{name}: expected {value}, observed {metrics[name]}"
    for name, value in expected.items() if metrics[name] != value
]
for name, value in metrics.items():
    print(f"{name}: {value}")
if failures:
    raise RuntimeError("Maintenance validation failed: " + "; ".join(failures))

print("Maintenance validation passed: the synthetic data product is ready.")



# METADATA ********************

# META {
# META   "language": "python",
# META   "language_group": "synapse_pyspark"
# META }

# CELL ********************


# METADATA ********************

# META {
# META   "language": "python",
# META   "language_group": "synapse_pyspark"
# META }
