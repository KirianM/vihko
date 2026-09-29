![The vihko logo](vihko.svg)
# Welcome to vihko
This is our team's notebook: plain Markdown files on our own server, with an editor for desktop and phone. If vihko ever went away, we would still have every word.

New here? Read [[Onboarding]], then [[How we write notes]]. #handbook #start-here

- [x] Run vihko with Docker Compose
- [x] Invite Ravi with a sign-up link
- [ ] Turn on the API and MCP, as agreed in [[2026-09-29 Weekly sync]]

| Folder | What goes there |
|---|---|
| `meetings` | The weekly syncs, date first |
| `people` | A personal folder each, private |

```yaml
permissions:
  "":
    grants: { hanna: manage, ravi: edit }
  people/{user}:
    grants: { "{user}": manage }
```
