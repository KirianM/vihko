# vihko guides

How to install, configure and run vihko. They're written for this version of
vihko (0.1): the guides in a release describe that release.

## Setting up

- [Installation](install.md): requirements, the compose file line by line,
  the notes folder with `people/` and `spaces/`, the first start and every
  environment variable.
- [Configuration](configuration.md): `vihko.yaml`, the workspace settings
  that live with your notes (shared spaces and sharing, daily notes,
  templates, images, links, history).
- [Spaces, people and sharing](users-and-permissions.md): your own space,
  shared spaces, folders shared with you, inviting people, groups, what the
  admin can and can't see, sign-in limits and two-step verification.
- [Reverse proxy](reverse-proxy.md): HTTPS and a public address with Caddy or
  nginx.

## Using

- [First steps in the app](first-steps.md): the sidebar and its spaces,
  creating notes and folders, links, tags, search and the ⌘K box, moving,
  images, comments, history, sharing, preferences and the phone.
- [Notes and Markdown](notes.md): what vihko reads and writes in your files
  (frontmatter, links, which stay inside their space, tags, comments, images), the
  trash, and editing with other tools at the same time.
- [History](history.md): the versions of every note, restoring them, and
  purging what should never have been kept.
- [Agents](agents.md): API keys, MCP on your network, remote MCP with OAuth,
  and what an agent can see.
- [API](api.md): the HTTP API reference.

## Running it

- [Upgrading](upgrading.md): what a 0.x version promises, which image tag to
  use, updating and rolling back, and coming from the withdrawn 1.0.x line.
- [What 0.x tries to keep](compatibility.md): the paths, API routes, MCP
  tools, `vihko.yaml` keys, variables and what vihko writes into your notes,
  as 0.1.0 has them.
- [Backups](backups.md): what to back up, a consistent copy, restoring, and
  testing the restore.
- [Operations](operations.md): the command line, the log, the health check,
  notes on NFS, and common problems.
