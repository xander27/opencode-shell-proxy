# opencode-shell-proxy

An [opencode](https://opencode.ai) plugin that routes shell commands run by the
agent through an HTTP proxy — without touching proxy settings of any other
application on the system.

It hooks [`shell.env`](https://opencode.ai/docs/plugins) and injects
`HTTPS_PROXY` / `HTTP_PROXY` / `NO_PROXY` into every shell invocation made
inside opencode only.

## Why

`export HTTPS_PROXY` in `.zshrc` sends *all* applications through the proxy.
This plugin scopes the proxy to opencode's shell tool alone.

## Install

Copy `proxy.js` to the global plugin directory:

```bash
mkdir -p ~/.config/opencode/plugins
curl -o ~/.config/opencode/plugins/proxy.js \
  https://raw.githubusercontent.com/xander27/opencode-shell-proxy/main/proxy.js
```

No dependencies, no `package.json` needed. Restart opencode after installing —
plugins are loaded once at startup.

## Configuration

The proxy URL is resolved at startup, in priority order:

1. `OPENCODE_SHELL_PROXY` environment variable — for setups without secrets
2. `~/.config/opencode/shell-proxy.env` file containing the URL on a single line

If neither is set, the plugin does nothing.

The variable is inert outside opencode — other apps never read it, so it is
safe to keep it in your `.zshrc`.

### Secrets

If the proxy requires credentials (`socks5h://user:pass@host:port`), prefer the
file: it stays out of shell rc-files, which often end up synced to dotfiles
repositories.

```bash
umask 077
printf '%s\n' 'socks5h://user:pass@host:1080' > ~/.config/opencode/shell-proxy.env
```

`umask 077` creates the file readable only by your user. Never commit it.

`NO_PROXY=localhost,127.0.0.1` is always set so local traffic (including the
opencode TUI server) stays direct.

## Health check

The plugin verifies the proxy before using it: it runs
`curl -fsS --proxy <url> <check-url>` at startup and re-checks lazily at most
once every 5 minutes (each check has a 10 second timeout, and `shell.env` waits
for a pending check to finish, so a command may stall up to 10 seconds when a
re-check is due).

- Check succeeds → `HTTPS_PROXY` / `HTTP_PROXY` are injected into shell calls.
- Check fails → nothing is injected (traffic goes direct), a warning toast is
  shown in the TUI and an error is written to the opencode log.
- Proxy comes back → a success toast is shown and routing resumes.

Tune the check with:

```bash
export OPENCODE_SHELL_PROXY_CHECK_URL=https://example.com   # default
```

Point it at a host you actually care about to verify end-to-end reachability.
Requires `curl` on PATH.

### SOCKS5 proxies

Prefer the `socks5h://` scheme over `socks5://`: with `socks5h` DNS resolution
also goes through the proxy, which matters when local DNS is unreliable for the
target host. Note that SOCKS URLs in env vars are understood by curl, git and
other libcurl-based tools, but not by everything (e.g. wget, many Node and
Python HTTP clients). For universal support, front the SOCKS proxy with an
HTTP bridge such as [gost](https://github.com/go-gost/gost):
`gost -L http://:8080 -F socks5://proxy:1080` and point this plugin at
`http://127.0.0.1:8080`.

## Orca

[Orca](https://orca.run) launches opencode sessions with a shared config dir
(`~/.config/orca/opencode-hooks/shared`), which replaces the global one. To get
the plugin in every Orca-spawned opencode, copy it there too:

```bash
mkdir -p ~/.config/orca/opencode-hooks/shared/plugins
cp proxy.js ~/.config/orca/opencode-hooks/shared/plugins/
```

The secret file path from [Configuration](#configuration) is absolute
(`~/.config/opencode/shell-proxy.env`), so it is picked up regardless of which
config dir the session uses.

## Limitations

Only the agent's shell commands are proxied. LLM API traffic and the built-in
webfetch tool are **not** proxied: they need proxy env vars at opencode process
start. For that, launch opencode itself with `HTTPS_PROXY` set (and
`NO_PROXY=localhost,127.0.0.1`, which is required for the local TUI server —
see [network docs](https://opencode.ai/docs/network)).

## Verify

```bash
curl -m 60 https://example.com
```

Inside an opencode session this should go through the proxy (`env | grep PROXY`
to confirm the variables are set).

## References

- [Plugins: Inject environment variables](https://opencode.ai/docs/plugins)
- [Network configuration](https://opencode.ai/docs/network)
