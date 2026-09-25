# Docker containers

Lists the Docker containers on one of your hosts.

## Usage

1. Switch the plugin on (Plugins page).
2. Run **Docker: containers on host…** from its card or the command palette (`Ctrl+K`).
3. Pick a host.

You get every container on that host — running and stopped — with its image and status:

```
NAME     IMAGE          STATUS
web      nginx:1.27     Up 3 hours
db       postgres:16    Exited (0) 2 days ago
```

## Requirements

- Docker on the host, and a user allowed to use it (member of the `docker` group).
  Otherwise the dialog shows Docker's own error, usually *permission denied*.

## Permissions

| Permission | Why |
|---|---|
| `hosts:exec` | Runs `docker ps -a` on the host you pick. Nothing else. |

It only reads: it never starts, stops or changes a container.
