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

Proxy URL is read from the `OPENCODE_SHELL_PROXY` environment variable at
startup, with a default of `http://127.0.0.1:8080`:

```bash
OPENCODE_SHELL_PROXY=http://127.0.0.1:8080 opencode
```

The variable is inert outside opencode — other apps never see it, so it is safe
to keep it in your `.zshrc`. If the proxy requires credentials
(`http://user:pass@host:port`), pass them via this variable rather than
committing them anywhere.

`NO_PROXY=localhost,127.0.0.1` is always set so local traffic (including the
opencode TUI server) stays direct.

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
