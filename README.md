# Microsoft Fabric demos

A growing collection of small, reproducible Microsoft Fabric demonstrations for Microsoft Fabric architects and engineers.
Each demo focuses on a practical scenario and includes the Fabric artifacts and guidance needed to reproduce it.

## Repository structure

All demos live under `demos/<demo-name>/`. Topics, format, maturity, and validation status reside in each demo's README.

```text
demos/
|-- fabric-connection-manager/
|   |-- README.md
|   |-- app/
|   `-- fabric/
`-- fabric-deployment-plan/
    |-- README.md
    `-- fabric/
```

Each demo contains only the technical assets and instructions needed to
understand and reproduce it.

## Available demos

| Demo | Outcome | Topics | Format | Status |
| --- | --- | --- | --- | --- |
| [Connection manager](demos/fabric-connection-manager/) | Inventory tenant connections and record deletion-review requests without deleting them. | Governance, Connections, Fabric Apps | Demo | Validated |
| [Deployment plans](demos/fabric-deployment-plan/) | Deploy items in order, initialize and validate a lakehouse, and use pipeline promotion and Git branch-out. | ALM, Deployment, Automation | How-to | Validated |

## Using the demos

Clone the repository if you want to inspect or edit the files locally:

```powershell
git clone https://github.com/mikkelos/fabric-demos.git
```

Follow each demo's setup instructions to create its Fabric items. Some demos
support Fabric Git integration. For the deployment plan demo, connect a
workspace to this repository through **Workspace settings > Git integration**,
select the `main` branch, and use:

```text
demos/fabric-deployment-plan/fabric
```

Follow the demo README for prerequisites, setup, expected results, limitations,
and cleanup. Some demos use synthetic data; others collect metadata from your
tenant. Features marked as Preview should be verified against the latest
Microsoft Fabric documentation.

## Disclaimer

This is a personal project. The examples are not official Microsoft guidance. Product behaviour and availability can change.
Verify current details in official documentation before using a pattern in production.

## License

Code and samples are available under the [MIT License](LICENSE).
