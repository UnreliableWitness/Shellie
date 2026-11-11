# The nightly agent goes live

Follows `2026-11-10-nightly-agent.md`.

- The Azure side of `docs/agents.md` step 5 is done: app registration `shellie-nightly-telemetry` with a service principal, a federated credential for `main`, and Monitoring Reader on resource group `shellie-telemetry`. Repo variables `AZURE_HEALTH_CLIENT_ID` and `AZURE_HEALTH_TENANT_ID` are set.
- The first login failed with AADSTS700213. This repo's GitHub OIDC tokens use immutable subjects (`repo:UnreliableWitness@1764189/Shellie@1418599084:ref:refs/heads/main`), not `repo:UnreliableWitness/Shellie:...`. Step 5 now reads the prefix from `gh api repos/UnreliableWitness/Shellie/actions/oidc/customization/sub` and writes it as `${sub}`, because in zsh `$sub:ref` applies the `:r` modifier.
- `AGENTS_NIGHTLY_MODE` is `live`, after three shadow runs whose proposals were checked.

## Verified

- A dispatched run (42981057045) logged in, queried App Insights, and the health agent proposed three issues from 4 sessions. Simplify had nothing new to read.

## Known gaps

- The Windows signing app `miac-ci-signing` still has its federated subject on the old repo name and the name-based format. It must be changed to `repo:UnreliableWitness@1764189/Shellie@1418599084:environment:release` before Windows signing is turned on.
- The first live run is tonight's at 03:27 UTC; the filed issues have not been seen yet.
