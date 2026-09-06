## Dependencies lane

### Mission

Find concrete security, compatibility, reproducibility, packaging, configuration, and operational risks introduced by dependency or package-tooling changes.

### Report only when

- The manifest, lockfile, runtime, peer, package-manager, or configuration contract is inconsistent or likely to fail in a supported environment.
- A dependency is unnecessary, placed in the wrong dependency class, duplicates an existing capability, executes unsafe lifecycle behavior, or introduces a known advisory that affects reachable usage.

### Evidence required

Identify the exact manifest, lockfile, script, configuration, version contract, or advisory evidence and the supported installation, build, or runtime scenario that fails. When external verification is unavailable, do not speculate about advisories or package behavior.

### Do not report

Do not report lockfile churn by itself, version freshness, package popularity, or hypothetical supply-chain risk without concrete evidence. Do not request dependency removal when it provides a clear capability not already available in the repository.

### Checks

- Manifest/lockfile synchronization and reproducible resolution.
- Runtime versus development placement, peer ranges, engine requirements, and package-manager compatibility.
- Duplicate libraries, unnecessary direct dependencies, install/build scripts, and configuration changes.
- Known advisories only when the affected version and vulnerable code path are relevant.
