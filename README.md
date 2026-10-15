# Microsoft Fabric demos

A growing collection of small, reproducible Microsoft Fabric demonstrations for Microsoft Fabric architects and engineers.
Each demo focuses on a practical scenario and includes the Fabric artifacts and guidance needed to reproduce it.

## Demo categories

- `new`: Hands-on tests of recently announced or released capabilities
- `how`: Evergreen implementation patterns
- `explained`: Focused answers to nuanced technical questions
- `lab`: Larger scenarios combining several capabilities
  
## Available demos

- [Deployment plans](new/fabric-deployment-plan/) - Deploy Fabric items in
  order, initialize and validate a lakehouse, promote through a deployment
  pipeline, and branch out to a new workspace.

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
new/fabric-deployment-plan/fabric
```

Synchronize the workspace, then follow the demo README for prerequisites,
setup, expected results, limitations, and cleanup. Demo data is synthetic, and
features marked as Preview should be verified against the latest Microsoft
Fabric documentation.

## Disclaimer

This is a personal project. The examples are not official Microsoft guidance. Product behaviour and availability can change.
Verify current details in official documentation before using a pattern in production.

## License

Code and samples are available under the [MIT License](LICENSE).
