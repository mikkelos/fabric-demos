# Fabric notebook source

# METADATA ********************

# META {
# META   "kernel_info": {
# META     "name": "synapse_pyspark"
# META   },
# META   "dependencies": {}
# META }

# MARKDOWN ********************

# ## Release gate
# This notebook is a release gate.  It will check whether deployment may continue before the lakehouse and dependent items are deployed
# For this demo, it will
# - Read the `allow_release` parameter
# - Report the execution workspace so we can verify it runs in the target.
# - Succeed when allowed. Raise an explicit error when denied or given an invalid value.
#
# ### Example scenario (not implemented)
# Release approval gate for a maintenance data product. Before promoting a release, the data owner reviews the source validation results and approves the change, for example confirming that revised asset-criticality classifications are ready for downstream maintenance planning. This notebook represents that approval using the `allow_release` parameter. If approval is missing or denied, it fails and stops dependent deployment groups before the lakehouse, initialization, and validation steps proceed.
#
# In this demo, approval is supplied manually. A production implementation could verify an approved change record for the specific release and target environment, including its approval expiry. This parameter is a demonstration gate, not an authorization control or an automated data-quality check. In prod it should not rely on a saved flag


# PARAMETERS CELL ********************

# Parameters cell with default values
allow_release = False

# METADATA ********************

# META {
# META   "language": "python",
# META   "language_group": "synapse_pyspark"
# META }

# CELL ********************

import notebookutils

context = notebookutils.runtime.context
workspace_id = context["currentWorkspaceId"]
workspace_name = context["currentWorkspaceName"]

if not workspace_id:
    raise RuntimeError("Preflight failed: execution workspace ID is unavailable.")

print(f"Execution workspace: {workspace_name} ({workspace_id})")

if not isinstance(allow_release, bool):
    raise ValueError("allow_release must be a bool true or false.")

if not allow_release:
    raise RuntimeError("Release blocked: allow_release is false.")

print("Preflight passed: release is allowed.")

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
