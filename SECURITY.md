# Security policy

## Reporting a vulnerability

Please report vulnerabilities privately through GitHub: open the
**Security** tab of the repository and choose **Report a vulnerability**. Do
not open a public issue, discussion or pull request for them.

Include what is affected (version or commit, and how vihko is deployed), the
steps to reproduce it and what an attacker gains. A proof of concept helps.

vihko is maintained by one person in their own time. You will get an answer as
soon as possible, and the fix and its advisory will credit you unless you
prefer otherwise.

## Supported versions

Security fixes go to `main` and come out in a new release of the latest
version: the image tags `1` and `latest` pick them up (see
[Upgrading](guide/upgrading.md)). Older releases and release candidates get
no fixes of their own: update to the latest release of your major version,
which never needs anything done by hand.

## Scope

In scope: the server, the web UI, the API, the MCP server, the Docker image
(`ghcr.io/kirianm/vihko`) and `compose.yaml` as published here, and the
workflows in `.github/` that build and publish them.

Out of scope: deployments that depart from the documentation (for example,
exposing plain HTTP to the internet without a TLS proxy), denial of service by
an administrator of the instance, and vulnerabilities of dependencies that
vihko does not reach (report those upstream).
