# Microsoft Fabric demos

A growing collection of small, reproducible Microsoft Fabric demonstrations for Microsoft Fabric architects and engineers.
Each demo focuses on a practical scenario and includes the Fabric artifacts and guidance needed to reproduce it.

## Repository structure

All demos live under `demos/<demo-name>/` with stable, lowercase kebab-case
names. Topics, format, maturity, and validation status belong in each demo's
README, not in category folders that change as a feature ages.

```text
demos/
`-- fabric-deployment-plan/
    |-- README.md
    `-- fabric/
```

Each demo contains only the technical assets and instructions needed to
understand and reproduce it.

## Available demos

| Demo | Outcome | Topics | Format | Status |
| --- | --- | --- | --- | --- |
| [Deployment plans](demos/fabric-deployment-plan/) | Deploy items in order, initialize and validate a lakehouse, and use pipeline promotion and Git branch-out. | ALM, Deployment, Automation | How-to | Validated |

## Using the demos

Clone the repository if you want to inspect or edit the files locally:

```powershell
git clone https://github.com/mikkelos/fabric-demos.git
```

To load a demo into Fabric, create a workspace and connect it directly to this
GitHub repository through **Workspace settings > Git integration**. Select the
`main` branch and the Git folder documented by the demo. For the deployment
plan demo, use:

```text
demos/fabric-deployment-plan/fabric
```

Synchronize the workspace, then follow the demo README for prerequisites,
setup, expected results, limitations, and cleanup. Demo data is synthetic, and
features marked as Preview should be verified against the latest Microsoft
Fabric documentation.

### Updating an existing Git connection

The deployment plan demo previously lived under
`new/fabric-deployment-plan/`. Its new location is
`demos/fabric-deployment-plan/`.

For a workspace connected to the old Git folder, update its Git integration
configuration to `demos/fabric-deployment-plan/fabric` before synchronizing.
Review the incoming changes before applying them; do not apply deletions
caused by a connection that still points to the old folder.

## Disclaimer

This is a personal project. The examples are not official Microsoft guidance. Product behaviour and availability can change.
Verify current details in official documentation before using a pattern in production.

## License

Code and samples are available under the [MIT License](LICENSE).
