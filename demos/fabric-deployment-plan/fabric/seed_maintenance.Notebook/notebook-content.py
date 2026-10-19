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

# # Initialize the maintenance demo
# Create five synthetic assets in the target lakehouse after deployment. Repeated runs replace only dbo.demo_maintenance_assets; this is demo initialization, not a production data migration.


# CELL ********************

import notebookutils
from pyspark.sql import functions as F
from pyspark.sql.types import StringType, StructField, StructType

context = notebookutils.runtime.context
workspace_id = context["currentWorkspaceId"]
lakehouse_id = context["defaultLakehouseId"]
lakehouse_workspace_id = context["defaultLakehouseWorkspaceId"]

if not workspace_id or not lakehouse_id:
    raise RuntimeError("Seed failed: a workspace and default lakehouse are required.")
if lakehouse_workspace_id != workspace_id:
    raise RuntimeError("Seed failed: the default lakehouse must belong to the execution workspace.")
if context["defaultLakehouseName"] != "maintenance_lh":
    raise RuntimeError("Seed failed: the default lakehouse must be maintenance_lh.")

print(f"Execution workspace: {context['currentWorkspaceName']} ({workspace_id})")
print(f"Target lakehouse: maintenance_lh ({lakehouse_id})")

table_name = "dbo.demo_maintenance_assets"
schema = StructType([
    StructField("asset_id", StringType(), False),
    StructField("asset_name", StringType(), False),
    StructField("facility", StringType(), False),
    StructField("criticality", StringType(), False),
    StructField("maintenance_status", StringType(), False),
])
assets = [
    ("asset_001", "Cooling Pump A", "Demo Facility North", "Critical", "Overdue"),
    ("asset_002", "Safety Valve B", "Demo Facility North", "Critical", "Scheduled"),
    ("asset_003", "Ventilation Fan C", "Demo Facility South", "Standard", "Complete"),
    ("asset_004", "Transfer Pump D", "Demo Facility South", "Standard", "Scheduled"),
    ("asset_005", "Filter Unit E", "Demo Facility North", "Standard", "Complete"),
]
seed_data = spark.createDataFrame(assets, schema)
seed_data.write.format("delta").mode("overwrite").saveAsTable(table_name)

result = spark.table(table_name)
counts = result.agg(
    F.count("*").alias("row_count"),
    F.countDistinct("asset_id").alias("unique_asset_count"),
    F.sum(F.when(F.col("criticality") == "Critical", 1).otherwise(0)).alias("critical_count"),
).first()

if (counts["row_count"], counts["unique_asset_count"], counts["critical_count"]) != (5, 5, 2):
    raise RuntimeError(f"Seed verification failed: {counts.asDict()}")

print(f"Seed complete: {table_name}; five assets, five unique IDs, two critical assets.")
result.orderBy("asset_id").show(truncate=False)


# METADATA ********************

# META {
# META   "language": "python",
# META   "language_group": "synapse_pyspark"
# META }
