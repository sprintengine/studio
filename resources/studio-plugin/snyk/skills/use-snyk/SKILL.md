---
name: use-snyk
description: Scan this workspace with Snyk for vulnerable dependencies, insecure code, hard-coded secrets, container and infrastructure-as-code problems, and check a package's health before adding it. Use when asked whether a project has known vulnerabilities, to review a dependency before adding or upgrading it, to check a Dockerfile or Terraform for misconfiguration, to look for committed secrets, to produce an SBOM, or when a Snyk scan refused to run and you need to know whether it was trust, authentication or the ecosystem's build tools.
---

# Snyk

The Snyk CLI's MCP server. Each tool runs a real scan of a real directory on
this machine and sends what it finds to Snyk's platform to be judged against
their vulnerability database. Nothing here is local-only, and one of the scans
runs your project's own build tooling. Both facts belong in what you tell the
person before you start.

## Before the first scan

`snyk_auth_status` says whether this machine is authenticated. `snyk_auth`
starts authentication, which opens a browser and needs a person — an unattended
agent that calls it will wait for something that is not going to happen, so
check the status first and report an unauthenticated machine rather than trying
to fix it. `snyk_logout` exists for the same person, not for you.

`snyk_trust` marks a folder as trusted, and scans refuse untrusted folders.
This is deliberate: scanning executes code from the project in some ecosystems,
so Snyk will not do it to a directory nobody has vouched for. Trust the
workspace you were asked about and nothing above it.

## Which scan answers which question

- `snyk_sca_scan` — the dependency tree. "Does this project pull in anything
  with a known CVE" is this one. **It may run the ecosystem's own build tools**
  (Gradle, Maven and friends) on this machine to resolve the tree, which can be
  slow, can hit the network, and can execute build scripts the repository
  carries. Say so before running it on a repository you did not write.
- `snyk_code_scan` — static analysis of the source itself: injection,
  path traversal, unsafe deserialisation and the rest. This is the one that
  sends source to Snyk for analysis. On a private or client repository, ask
  first.
- `snyk_iac_scan` — Terraform, CloudFormation, Kubernetes manifests and Helm
  charts, judged against misconfiguration rules. It reads files; it does not
  reach any cloud account.
- `snyk_container_scan` — a container image's base layers and OS packages.
- `snyk_secret_scan` — credentials committed into the tree.
- `snyk_sbom_scan` — an existing SBOM file, rather than the project.
- `snyk_aibom` — produces an AI bill of materials for the project.
- `snyk_package_health_check` — one package, before you depend on it: how it
  scores on security and maintenance. This is the cheap call to make when
  someone asks "should we add X", and it needs no scan of the workspace at all.
- `snyk_version` — the CLI's version, which is what to quote when a result
  looks wrong.

## Reading a result

A finding is a claim about a version, with a severity and usually a fixed-in
version. Report the severity, the package or file, and what fixes it. Do not
upgrade anything as a side effect of being asked to scan: a transitive
dependency's fix is often a major bump of the direct one, and the person asking
"are we vulnerable" has not asked you to change their lockfile.

Severity is Snyk's, not yours. A critical in a dev-only dependency that never
ships is a different problem from a critical in a runtime path, and the scan
cannot tell them apart — that judgement is worth stating alongside the count,
but state it as your reading and keep Snyk's severity intact.

Zero findings means zero findings **for the ecosystems Snyk resolved**. A
repository whose manifest could not be parsed scans as clean. Check that the
scan actually found the project's dependency files before reporting an all
clear, and quote what it scanned.

## When a scan refuses

Three refusals look similar and have different owners. An untrusted folder is
`snyk_trust`, and yours to fix. An unauthenticated machine is `snyk_auth`, and
a person's. A missing build tool — no Gradle for a Gradle project, no
`node_modules` for a lockfile-less npm project — is the environment's, and the
honest report names the tool rather than calling the project clean.
