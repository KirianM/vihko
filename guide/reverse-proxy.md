# Reverse proxy

vihko speaks plain HTTP and needs no reverse proxy on a network you trust. Put
one in front of it when you want HTTPS. This guide says when that is, what
vihko needs from the proxy, and gives a minimal Caddy and nginx setup.

## When you need one

- **Reaching vihko over the Internet**, or over any network you don't trust.
  Plain HTTP sends passwords and session cookies in the clear. **Never expose
  vihko's port to the Internet without HTTPS in front.**
- **Remote MCP with OAuth**, for assistants that connect from their own
  servers (such as claude.ai): they need a public `https://` address. See
  [Agents](agents.md).
- **Installing vihko as an app** from the browser (a PWA): browsers only offer
  it over HTTPS (or on `localhost`). Over plain HTTP the UI works the same, on
  a phone too, but a home-screen shortcut opens a browser tab.

If you only want to reach vihko from outside your network yourself, a VPN to
that network is an alternative to a public address.

## What vihko needs from the proxy

- **The whole site, at the root** of a name: `https://notes.example.com/`.
  vihko can't be served under a path such as `https://example.com/notes/`.
- **Keep the `Host` header** the browser sent. vihko refuses a change (a
  sign-in, a save) whose `Origin` doesn't match the host it was sent to, and
  refuses the live editor's connection the same way. A proxy that replaces
  `Host` with vihko's internal address makes every sign-in fail with `403`.
- **Set `X-Forwarded-Proto: https`.** vihko marks its session cookie `Secure`
  from it, so the browser never sends it over plain HTTP.
- **Pass WebSocket upgrades.** The live editor connects to `/collab` with a
  WebSocket and keeps it open. Without it, the editor stays offline: notes
  don't save and don't show other people's changes.
- **Set `X-Forwarded-For`**, and tell vihko the proxy's address (below), so the
  sign-in limits count each client apart.
- **Long enough timeouts**: more than 60 seconds for a request. `/mcp` may
  wait up to 30 seconds for a change before it answers.
- **Request bodies up to 20 MB**: images (up to `VIHKO_MAX_IMAGE_MB`, 20 by
  default) and API requests.

Caddy does all of this on its own. nginx needs it spelled out.

## Who reaches vihko's port

Once the proxy is in front, only the proxy needs to reach vihko. How to close
the port to everyone else depends on **where the proxy runs**:

| The proxy runs… | vihko's `ports:` in `compose.yaml` |
|---|---|
| On the same machine as vihko | `"127.0.0.1:${VIHKO_HOST_PORT:-8080}:8080"`: [on this machine](#a-proxy-on-the-same-machine) |
| In the same compose file | None at all: [Caddy in the same compose file](#caddy-in-the-same-compose-file) |
| On another machine of your network (another VM, a container on another host) | The default line, which the proxy can reach: [on another machine](#a-proxy-on-another-machine) |

### A proxy on the same machine

Publish the port on `127.0.0.1` only, with this line instead of the default
one:

```yaml
    ports:
      - "127.0.0.1:${VIHKO_HOST_PORT:-8080}:8080"
```

`127.0.0.1` is the machine talking to itself: nothing else on the network can
connect. **Only use it when the proxy runs on the same machine as vihko.**

### A proxy on another machine

The proxy connects to vihko over your network, so vihko's port must stay
published on the network: **keep the default line**
(`"${VIHKO_HOST_PORT:-8080}:8080"`). With the `127.0.0.1` line the proxy can't
reach vihko at all, and every page answers `502 Bad Gateway`.

Say vihko's machine is `10.0.0.20` and the proxy's is `10.0.0.50` (use your
own addresses). The proxy forwards to `http://10.0.0.20:8080`, and vihko gets
the proxy's address:

```yaml
    ports:
      - "${VIHKO_HOST_PORT:-8080}:8080"
    environment:
      VIHKO_PUBLIC_URL: https://notes.example.com
      VIHKO_TRUSTED_PROXIES: 10.0.0.50
```

The port still answers anyone on your network, over plain HTTP. To narrow it:

- **Publish it on one address of the machine**, the one on the proxy's
  network (`"10.0.0.20:${VIHKO_HOST_PORT:-8080}:8080"`), when the machine has
  others (a second network, a VPN) where vihko shouldn't answer.
- **Let only the proxy in, with a firewall rule** for the port. Docker sends
  published ports past the usual rules of `ufw` and `firewalld`: the rule
  goes in Docker's `DOCKER-USER` chain, as Docker's
  [packet filtering guide](https://docs.docker.com/engine/network/packet-filtering-firewalls/)
  explains, or on the firewall of your network.

## Tell vihko about the proxy

Under `environment:` in `compose.yaml`:

```yaml
    environment:
      VIHKO_PUBLIC_URL: https://notes.example.com
      # A proxy on this machine or in this compose file. On another machine:
      # that machine's address alone, such as 10.0.0.50 (see below).
      VIHKO_TRUSTED_PROXIES: 172.16.0.0/12
```

Then `docker compose up -d`.

- **`VIHKO_PUBLIC_URL`** is the address people and apps use: `https://`, the
  name, and a port only if it isn't 443. Nothing after the name. It makes OAuth
  available for remote MCP clients while the MCP server is on (claude.ai and
  `mcp-remote` also need **OAuth apps can register themselves**: see
  [Agents](agents.md#remote-mcp-with-oauth)), and invitation
  and password-reset links use it, even when an admin makes them from another
  address (on your network, say). The log confirms it: `public URL https://notes.example.com: OAuth for https://notes.example.com/mcp while the MCP server is on`.

- **`VIHKO_TRUSTED_PROXIES`** lists the addresses (or CIDR ranges) the proxy's
  requests come from, **as vihko sees them**. Only from those does vihko
  believe `X-Forwarded-For`. Which address that is:

  | Setup | What vihko sees | Value |
  |---|---|---|
  | Proxy on the host, vihko in Docker (port on `127.0.0.1`) | The gateway of vihko's Docker network, such as `172.18.0.1`, not `127.0.0.1` | `172.16.0.0/12` |
  | Proxy in the same compose file | The proxy container's address on the compose network | `172.16.0.0/12` |
  | Proxy on another machine | That machine's own address on your network: Docker passes it on unchanged | that one address, such as `10.0.0.50` |
  | vihko without Docker, proxy on the same host | The loopback address | `127.0.0.1, ::1` |

  Docker gives its networks addresses in `172.16.0.0/12` unless you (or many
  existing networks) made it use others. To check yours, from the folder of
  `compose.yaml`, print the gateway of vihko's network:

  ```sh
  docker inspect "$(docker compose ps -q vihko)" --format '{{range .NetworkSettings.Networks}}{{.Gateway}} {{end}}'
  ```

  Trust only addresses nobody else can connect from: whoever reaches vihko
  from a trusted address can write any client address in `X-Forwarded-For`.
  A range is safe in the first two rows because only the proxy can connect
  from it: the port is bound to `127.0.0.1`, or not published at all.

  **A proxy on another machine is one address, never a range.** The number
  after a `/` is how many leading bits of the address count, and the rest is
  ignored: `10.0.0.50/8` is not the proxy, it's all of `10.0.0.0/8`, every
  device on a typical home or office network. Each of them could then send
  a made-up `X-Forwarded-For` with every password guess and never be slowed
  down: the sign-in limits stop working. Write the address alone
  (`10.0.0.50`, which is the same as `10.0.0.50/32`).

  vihko doesn't log the addresses it sees. To find the proxy's, look on the
  proxy's machine (`ip -4 addr`, or its network settings). To see the
  connections vihko receives, with their addresses, from the folder of
  `compose.yaml` while you load a page through the proxy:

  ```sh
  sudo nsenter -t "$(docker inspect -f '{{.State.Pid}}' "$(docker compose ps -q vihko)")" -n ss -tn
  ```

  The `Peer Address` column is what vihko sees: the address to trust.

What goes wrong without them:

- **Without `VIHKO_TRUSTED_PROXIES`**, every request seems to come from the
  proxy. The sign-in limits then count everyone as one client: someone
  guessing passwords makes everyone else wait to sign in. vihko warns in the
  log at start when `VIHKO_PUBLIC_URL` is set and this isn't. The limits
  themselves are described in [Users and permissions](users-and-permissions.md).
- **Without `VIHKO_PUBLIC_URL`**, everything works in the browser, but remote
  MCP clients can't sign in with OAuth (every OAuth address answers 404), and
  `vihko user reset-link` prints the link without the address in front.
- **Without `X-Forwarded-Proto: https`**, the session cookie isn't marked
  `Secure`.

## Caddy

[Caddy](https://caddyserver.com) gets and renews the certificate on its own,
and passes WebSockets, `Host`, `X-Forwarded-For` and `X-Forwarded-Proto`
without any setting. The name must point to your server, and ports 80 and 443
must reach Caddy from the Internet for the certificate.

### Caddy on the host

With Caddy installed on the same machine, and vihko's port bound to
`127.0.0.1:8080`, the whole `Caddyfile`:

```caddy
notes.example.com {
	reverse_proxy 127.0.0.1:8080
}
```

### Caddy on another machine

The same `Caddyfile`, with vihko's machine address instead of `127.0.0.1`,
and vihko's port published on the network as in
[A proxy on another machine](#a-proxy-on-another-machine):

```caddy
notes.example.com {
	reverse_proxy 10.0.0.20:8080
}
```

### Caddy in the same compose file

Caddy as a second service, in front of vihko on the compose network. vihko's
port isn't published at all.

Leave `compose.yaml` as it is, and put this in a `compose.override.yaml` next
to it. `docker compose` reads both files, and the override only adds to
`compose.yaml`: vihko keeps its image, its `user:` and its hardening
(`read_only`, `cap_drop`, `security_opt`), and a new `compose.yaml` you
download later still applies. `!reset []` removes vihko's published port
(Compose 2.24 or newer).

```yaml
services:
  vihko:
    ports: !reset []
    environment:
      VIHKO_PUBLIC_URL: https://notes.example.com
      VIHKO_TRUSTED_PROXIES: 172.16.0.0/12

  caddy:
    image: caddy:2
    restart: unless-stopped
    ports:
      - "80:80"
      - "443:443"
      - "443:443/udp"
    volumes:
      - ./Caddyfile:/etc/caddy/Caddyfile:ro
      - caddy_data:/data
      - caddy_config:/config

volumes:
  caddy_data:
  caddy_config:
```

And the `Caddyfile` next to it:

```caddy
notes.example.com {
	reverse_proxy vihko:8080
}
```

`docker compose config` shows the two files merged: the `vihko` service has
no `ports:`, and still has `read_only`, `cap_drop`, `security_opt` and
`user:`.

## nginx

A minimal site, with the certificate already in place (for example from
[Certbot](https://certbot.eff.org)) and vihko's port bound to
`127.0.0.1:8080`. With nginx on another machine, write vihko's machine address
in `proxy_pass` instead (`http://10.0.0.20:8080`), and keep vihko's port
published on the network ([A proxy on another machine](#a-proxy-on-another-machine)):

```nginx
map $http_upgrade $connection_upgrade {
    default upgrade;
    ''      close;
}

server {
    listen 80;
    server_name notes.example.com;
    return 301 https://$host$request_uri;
}

server {
    listen 443 ssl;
    http2 on;
    server_name notes.example.com;

    ssl_certificate     /etc/letsencrypt/live/notes.example.com/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/notes.example.com/privkey.pem;

    # Images and API requests: up to 20 MB (VIHKO_MAX_IMAGE_MB).
    client_max_body_size 20m;

    location / {
        proxy_pass http://127.0.0.1:8080;
        proxy_http_version 1.1;

        # vihko compares Origin with Host: keep the browser's Host.
        proxy_set_header Host              $http_host;
        proxy_set_header X-Forwarded-For   $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;

        # The live editor's WebSocket (/collab).
        proxy_set_header Upgrade           $http_upgrade;
        proxy_set_header Connection        $connection_upgrade;

        # /mcp may wait 30 seconds for a change.
        proxy_read_timeout 300s;
    }
}
```

`proxy_set_header Host` matters: without it, nginx sends its upstream address
(`127.0.0.1:8080`) as the host, and vihko refuses every sign-in with `403`.

## Check it

1. The proxy reaches vihko:

   ```sh
   curl https://notes.example.com/api/health
   ```

   ```json
   {"ok":true}
   ```

2. Sign in at `https://notes.example.com`. A `403` here means the `Host`
   header isn't kept.
3. Open the same note in two browsers (or a private window) and type in one:
   the other shows it at once. If the note doesn't save, or says it's
   offline, WebSockets aren't passed.
4. The log shows the `public URL …` line, and no warning about
   `VIHKO_TRUSTED_PROXIES`:

   ```sh
   docker compose logs vihko | grep -i 'public url\|trusted'
   ```

To connect assistants through this address, continue with
[Agents](agents.md).

## The proxy can't reach vihko (502 Bad Gateway)

Every page answers `502 Bad Gateway` (Caddy, nginx) or a similar error of the
proxy's own: the proxy can't connect to vihko. From the proxy's machine (or
container), ask vihko directly:

```sh
curl http://10.0.0.20:8080/api/health
```

That's the address and port the proxy forwards to: vihko's machine and its
host port (`127.0.0.1:8080` for a proxy on the same machine, `vihko:8080` in
the same compose file). `{"ok":true}` means vihko answers, and the proxy's
own configuration points elsewhere. Otherwise:

- **The port is bound to `127.0.0.1` and the proxy is on another machine.**
  `docker compose ps` shows `127.0.0.1:8080->8080/tcp` under `PORTS`. Put the
  default line back ([A proxy on another machine](#a-proxy-on-another-machine))
  and `docker compose up -d`.
- **The wrong port.** With `VIHKO_HOST_PORT` set, the proxy must use that
  port, not 8080. In the same compose file, it's always `vihko:8080`.
- **A firewall** between the two machines, or on vihko's, drops the
  connection.
- **vihko isn't running**, or restarts in a loop: `docker compose ps` and
  `docker compose logs vihko` say why.
