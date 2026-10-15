# Fabric Deployment Plan

**Deploy a ready-to-use data product, not just its definitions.**

This demo uses a Microsoft Fabric deployment plan to deploy items in order,
initialize a lakehouse, and validate the result. The same plan is used for a
deployment pipeline promotion and for Git branch-out to a new workspace.

## Status

| Field | Value |
| --- | --- |
| Demo status | Validated |
| Last updated | 2026-10-15 |
| Product maturity | Deployment plans: Preview |

## Demo scenario

The demo represents a small asset-maintenance data product. A deployment is
only successful when the target workspace contains the required Fabric items,
five synthetic maintenance records, and a passing validation result.

The release sequence is:

```text
Deploy preflight notebook
    -> Run preflight and deploy lakehouse
    -> Deploy and run seed notebook
    -> Deploy and run validation notebook
```

The plan is demonstrated in two ways:

1. Promote from a Dev workspace to a Test workspace through a deployment
   pipeline.
2. Create an isolated feature workspace through Git branch-out.

## Fabric workspaces

```text
Dev workspace ----------------------------> Test workspace
      |              deployment pipeline
      |
      +---- Git branch-out ---------------> Feature workspace
```

- **Dev** contains the authored items and is synchronized with Git.
- **Test** receives the items through a deployment pipeline.
- **Feature** is created during branch-out and initialized by the Git-committed
  deployment plan.

Each target receives its own lakehouse and synthetic data.

## Demo artifacts

| Item | Type | Purpose |
| --- | --- | --- |
| `release_preflight` | Notebook | Report the execution workspace and stop the release when `allow_release` is false. |
| `maintenance_lh` | Lakehouse | Store the synthetic maintenance table. |
| `seed_maintenance` | Notebook | Create or replace five synthetic asset records. |
| `validate_maintenance` | Notebook | Validate row count, unique IDs, categories, and critical assets. |
| `maintenance_release` | Deployment plan | Define deployment order and notebook actions. |

The seed notebook is repeatable and replaces only the demo-owned table. Running
the deployment again should still produce five rows, including two critical
assets.

## Prerequisites

- A Fabric capacity in a supported region
- Permission to create and run Fabric notebooks and deployment plans
- Deployment plan creation enabled in the tenant
- A Dev and Test workspace assigned to a deployment pipeline
- Fabric Git integration and access to create a branch workspace
- Contributor or higher access in the source workspace

No external data source, gateway, client secret, or custom application
registration is required.

## Setup

1. Create the Dev and Test workspaces and assign them to a two-stage deployment
   pipeline.
2. In Dev, create `maintenance_lh` and the three notebooks.
3. Set `maintenance_lh` as the default lakehouse for `seed_maintenance` and
   `validate_maintenance`.
4. Enable lakehouse auto-binding in the Git settings for both
   lakehouse-dependent notebooks.
5. Run the seed and validation notebooks once in Dev.
6. Create `maintenance_release` with these groups:

   | Order | Item | Pre-deploy action | Post-deploy action |
   | --- | --- | --- | --- |
   | 1 | `release_preflight` | None | None |
   | 2 | `maintenance_lh` | Run `release_preflight` with `allow_release=true` | None |
   | 3 | `seed_maintenance` | None | Run `seed_maintenance` |
   | 4 | `validate_maintenance` | None | Run `validate_maintenance` |

7. Connect Dev to Git and commit the plan and all referenced items together.
8. Confirm the workspace is synchronized before deploying or branching out.

Lakehouse auto-binding is important. It allows the notebooks to resolve
`maintenance_lh` in the target workspace instead of retaining the Dev
workspace binding.

## Run with a deployment pipeline

1. Start a deployment from Dev to Test.
2. Select the lakehouse, all three notebooks, and the deployment plan.
3. Attach the incoming `maintenance_release` plan.
4. Run the deployment and inspect the action results.
5. In Test, confirm that the maintenance table contains five rows and that
   validation completed without manually running a target notebook.

Attaching a plan does not automatically select all referenced items. Include
every item required by the plan.

## Run with Git branch-out

1. Confirm Dev is committed and synchronized with Git.
2. Open **Source control > Branches > Branch out with deployment plan**.
3. Create a feature branch and a new workspace.
4. Select the Git-committed `maintenance_release` plan.
5. Complete branch-out.
6. Confirm the notebooks use the new workspace's `maintenance_lh`.
7. Confirm the synthetic table contains five rows and validation passed.

Branch-out copies item definitions, not lakehouse data. The seed action creates
the data in the new workspace.

## Expected result

- The preflight action runs before dependent groups.
- The target receives its own lakehouse and notebooks.
- The seed action creates five synthetic asset records.
- The validation action passes in the target workspace.
- No manual notebook execution is required in the target.
- Repeating the deployment does not create duplicate rows.

## Limitations

- Deployment plans are Preview.
- A plan must be attached to each operation.
- One plan and one target workspace are supported per operation.
- Failed operations do not roll back completed work.
- A deployment plan does not provision workspace identities, connections,
  gateways, or Spark settings.
- An action ending does not guarantee downstream service synchronization.

## Cleanup

Stop notebook sessions after testing. Remove only disposable workspaces,
branches, deployment pipelines, and demo items created for this scenario.
Preserve shared capacity, repositories, and source definitions.

Deleting the lakehouse also removes its generated SQL analytics endpoint; the
endpoint is not a separate authored demo item.

## References

- [Deployment plan overview](https://learn.microsoft.com/en-us/fabric/cicd/deployment-plan/deployment-plan-overview)
- [Create a deployment plan](https://learn.microsoft.com/en-us/fabric/cicd/deployment-plan/how-to-create-deployment-plan)
- [Deployment plan actions](https://learn.microsoft.com/en-us/fabric/cicd/deployment-plan/deployment-plan-actions)
- [Attach a deployment plan](https://learn.microsoft.com/en-us/fabric/cicd/deployment-plan/deployment-plan-attach)
- [Branch out with a deployment plan](https://learn.microsoft.com/en-us/fabric/cicd/git-integration/branched-workspace#branch-out-with-a-deployment-plan)
- [Notebook source control and deployment](https://learn.microsoft.com/en-us/fabric/data-engineering/notebook-source-control-deployment)

## Disclaimer

This is a personal technical demonstration using synthetic data. It is not
official Microsoft guidance. Verify current product documentation before
production use.
