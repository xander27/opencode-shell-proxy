# opencode-shell-proxy

An [opencode](https://opencode.ai) plugin that routes both the agent's shell
commands **and** the LLM API traffic through a SOCKS5 or HTTP proxy — without
touching proxy settings of any other application on the system.

```
shell tools (shell.env hook) ────┐
LLM requests (process env) ──────┤
                                 ▼
                     gost bridge 127.0.0.1:18181 ──F──► socks5://user:pass@host:1080
```

## Why

`export HTTPS_PROXY` in `.zshrc` sends *all* applications through the proxy —
and most runtimes (including opencode's Bun) don't even support `socks5://`
in proxy env vars. This plugin scopes proxying to opencode alone and bridges
SOCKS to HTTP locally.

## Install

Copy `proxy.js` to the global plugin directory:

```bash
mkdir -p ~/.config/opencode/plugins
curl -o ~/.config/opencode/plugins/proxy.js \
  https://raw.githubusercontent.com/xander27/opencode-shell-proxy/main/proxy.js
```

Restart opencode after installing — plugins are loaded once at startup.
Requires `curl` and `tar` on PATH (present by default on Linux/macOS).

## Configuration

The upstream proxy URL is resolved at startup, in priority order:

1. `OPENCODE_SHELL_PROXY` environment variable — for setups without secrets
2. `~/.config/opencode/shell-proxy.env` file containing the URL on a single line

If neither is set, the plugin does nothing.

URL schemes:

- `socks5://` / `socks5h://` — a local HTTP bridge is started on
  `127.0.0.1:18181` and both shell and LLM traffic are pointed at it. Prefer
  `socks5h://`: DNS also goes through the proxy, which matters when local DNS
  is unreliable for the target host.
- `http://` / `https://` — used directly, no bridge.

Optional environment variables:

| Variable | Default | Purpose |
| --- | --- | --- |
| `OPENCODE_SHELL_PROXY_BRIDGE_PORT` | `18181` | Local bridge port |
| `OPENCODE_SHELL_PROXY_CHECK_URL` | `https://example.com` | Health-check target |
| `OPENCODE_SHELL_PROXY_CHECK_TIMEOUT_MS` | `10000` | Health-check curl timeout |
| `OPENCODE_SHELL_PROXY_RECHECK_MS` | `300000` | Re-check interval |

## How it works

At startup the plugin:

1. Resolves the upstream URL and, for SOCKS, makes sure the `gost` bridge is
   listening on `127.0.0.1:18181` — reusing an existing one or spawning a new
   one (detached, shared across opencode sessions). The `gost` binary is
   looked up in `PATH`, then `~/.local/bin`, then downloaded from
   [go-gost/gost releases](https://github.com/go-gost/gost/releases) into
   `~/.cache/opencode-shell-proxy/` (sha256-verified against the release
   `checksums.txt`).
2. Health-checks the whole chain with
   `curl -fsS --proxy <url> <check-url>` (10 s timeout), re-checking lazily at
   most once per 5 minutes.
3. When healthy, injects `HTTPS_PROXY` / `HTTP_PROXY` / `NO_PROXY` into every
   shell invocation (the [`shell.env`](https://opencode.ai/docs/plugins) hook)
   and sets the same variables in the opencode process environment, so LLM
   requests go through the proxy too. The runtime picks these up per request.
4. When the check fails, nothing is proxied: shell commands get
   `NO_PROXY="*"` (direct traffic, neutralizing any inherited proxy junk) and
   the process proxy variables are cleared. A warning toast is shown in the
   TUI and an error is written to the opencode log. When the proxy comes
   back, a success toast is shown and routing resumes automatically.

`NO_PROXY=localhost,127.0.0.1` is always honoured so local traffic (including
the opencode TUI server) stays direct.

## Secrets

If the proxy requires credentials (`socks5h://user:pass@host:1080`), keep the
URL in the file: it stays out of shell rc-files, which often end up synced to
dotfiles repositories.

```bash
umask 077
printf '%s\n' 'socks5h://user:pass@host:1080' > ~/.config/opencode/shell-proxy.env
```

`umask 077` creates the file readable only by your user. Never commit it.

Credential masking is applied to everything the plugin writes to logs and
toasts. Note one residual exposure: the bridge is started as
`gost -F <upstream-url>`, so on a *shared multi-user machine* the upstream URL
(including credentials) is visible in `ps` output to other users. On a personal
machine this is a non-issue.

If you previously exported the SOCKS URL globally (e.g. `HTTPS_PROXY` in
`.zshenv`), remove it — runtimes like Bun reject `socks5://` proxy URLs, so it
breaks LLM calls, and it leaks the proxy to every app on the system.

## Orca

[Orca](https://orca.run) launches opencode sessions with a shared config dir
(`~/.config/orca/opencode-hooks/shared`), which replaces the global one. To get
the plugin in every Orca-spawned opencode, copy it there too:

```bash
mkdir -p ~/.config/orca/opencode-hooks/shared/plugins
cp proxy.js ~/.config/orca/opencode-hooks/shared/plugins/
```

The secret file path is absolute (`~/.config/opencode/shell-proxy.env`), so it
is picked up regardless of which config dir the session uses.

## Verify

Inside an opencode session:

```bash
env | grep PROXY          # HTTPS_PROXY should point at http://127.0.0.1:18181
curl -m 60 https://m.flibusta.is/ -o /dev/null -w '%{http_code}\n'
```

For LLM traffic: while the model responds, `ss -tnp | grep 18181` should show
opencode connections to the bridge.

## References

- [Plugins: Inject environment variables](https://opencode.ai/docs/plugins)
- [Network configuration](https://opencode.ai/docs/network)
- [gost](https://github.com/go-gost/gost)
