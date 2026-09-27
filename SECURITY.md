# Security policy

## Reporting a vulnerability

Please report vulnerabilities privately through GitHub: open the
**Security** tab of the repository and choose **Report a vulnerability**. Do
not open a public issue, discussion or pull request for them.

Include what is affected (version or commit, and how thoth is deployed), the
steps to reproduce it and what an attacker gains. A proof of concept helps.

thoth is maintained by one person in their own time. You will get an answer as
soon as possible, and the fix and its advisory will credit you unless you
prefer otherwise.

## Supported versions

thoth has no releases yet: fixes go to `main`. Once there are releases, the
latest one gets security fixes.

## Scope

In scope: the server, the web UI, the API, the MCP server, the Docker image
and `compose.yaml` as published here.

Out of scope: deployments that depart from the documentation (for example,
exposing plain HTTP to the internet without a TLS proxy), denial of service by
an administrator of the instance, and vulnerabilities of dependencies that
thoth does not reach (report those upstream).
