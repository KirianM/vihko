# vihko guides

How to install, configure and run vihko. They're written for this version of
vihko: the guides in a release describe that release.

## Setting up

- [Installation](install.md): requirements, the compose file line by line,
  the first start and every environment variable.
- [Configuration](configuration.md): `vihko.yaml`, the workspace settings
  that live with your notes (daily notes, templates, images, links, history).
- [Spaces, people and sharing](users-and-permissions.md): inviting people, groups,
  per-folder permissions, sign-in limits and two-step verification.
- [Reverse proxy](reverse-proxy.md): HTTPS and a public address with Caddy or
  nginx.

## Using

- [First steps in the app](first-steps.md): creating notes and folders,
  links, tags, search and the ⌘K box, moving, images, comments, history,
  sharing, preferences and the phone.
- [Notes and Markdown](notes.md): what vihko reads and writes in your files
  (frontmatter, links, tags, comments, images), the trash, and editing with
  other tools at the same time.
- [History](history.md): the versions of every note, restoring them, and
  purging what should never have been kept.
- [Agents](agents.md): API keys, MCP on your network, remote MCP with OAuth,
  and what an agent can see.
- [API](api.md): the HTTP API reference.

## Running it

- [Upgrading](upgrading.md): what a version promises, which image tag to use,
  updating and rolling back.
- [What 1.x keeps stable](compatibility.md): the API routes, MCP tools,
  `vihko.yaml` keys, variables and note formats that every 1.x release keeps.
- [Backups](backups.md): what to back up, a consistent copy, restoring, and
  testing the restore.
- [Operations](operations.md): the command line, the log, the health check,
  notes on NFS, and common problems.
