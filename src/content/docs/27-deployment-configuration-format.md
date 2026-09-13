---
title: "27. Deployment Configuration Format"
description: "The configuration format and the reasoning behind each design choice."
sidebar:
  order: 27
---

Fully specified in [§9.3](../09-universal-runtime-specification/#93-project-configuration-helixyaml--complete-schema). The summary of *why* the format looks like that:

| Principle | Manifestation |
|---|---|
| Versioned | `version: 1` at the top |
| Minimal happy path | A working config is 6 lines; everything else has a sane default |
| Environments are first-class | `environments:` block, not three files |
| Nothing implicit about resources | `resources` and `scaling` are explicit and validated against plan |
| Separation of build-time and run-time | Distinct `build.env`/`build.secrets` vs `env`/`secrets` |
| Escape hatch always available | `build.dockerfile` or `image:` for anything the managed path cannot express |
| Config is data, not code | No templating language, no scripting. If users need logic, they generate the YAML |

Minimal viable config:

```yaml
version: 1
name: my-api
runtime:
  type: go
  version: "1.23"
http:
  port: 8080
```

And the file is optional entirely — `helix init` can infer everything from the repo for the common cases, storing the resolved config in the dashboard. **Zero-config deploys for the top 5 runtimes is the single highest-leverage DX investment.**
