import { execFile } from "node:child_process"
import { readFileSync } from "node:fs"
import { homedir } from "node:os"

const CHECK_URL_DEFAULT = "https://example.com"
const CHECK_TIMEOUT_MS = 10_000
const RECHECK_INTERVAL_MS = 5 * 60_000

const fromFile = () => {
  try {
    const url = readFileSync(`${homedir()}/.config/opencode/shell-proxy.env`, "utf8").trim()
    return url || undefined
  } catch {
    return undefined
  }
}

const redact = (url) => url.replace(/\/\/[^/@]*@/, "//***@")

export const ProxyPlugin = async ({ client }) => {
  const url = process.env.OPENCODE_SHELL_PROXY ?? fromFile()
  if (!url) return {}

  const checkUrl = process.env.OPENCODE_SHELL_PROXY_CHECK_URL || CHECK_URL_DEFAULT

  let available = false
  let reported = false
  let lastCheckAt = 0
  let checking = null

  const report = (level, message) => {
    client?.app?.log({ body: { service: "opencode-shell-proxy", level, message } })?.catch?.(() => {})
  }

  const toast = (message, variant) => {
    client?.tui?.showToast({ body: { title: "shell-proxy", message, variant, duration: 5000 } })?.catch?.(() => {})
  }

  const check = () => {
    if (checking) return checking
    checking = new Promise((resolve) => {
      execFile(
        "curl",
        ["-fsS", "-o", "/dev/null", "-m", String(Math.ceil(CHECK_TIMEOUT_MS / 1000)), "--proxy", url, checkUrl],
        { timeout: CHECK_TIMEOUT_MS + 2000 },
        (err) => resolve(!err),
      )
    }).then((ok) => {
      checking = null
      lastCheckAt = Date.now()
      if (ok && reported) {
        reported = false
        report("info", `proxy ${redact(url)} is back, routing shell traffic through it`)
        toast("proxy is back online, shell traffic routed through it", "success")
      } else if (!ok && !reported) {
        reported = true
        report("error", `proxy ${redact(url)} failed check against ${checkUrl}, shell traffic goes direct`)
        toast("shell proxy unreachable — shell traffic goes direct", "warning")
      }
      available = ok
      return ok
    })
    return checking
  }

  check()

  return {
    "shell.env": async (input, output) => {
      if (Date.now() - lastCheckAt > RECHECK_INTERVAL_MS) await check()
      if (!available) return
      output.env.HTTPS_PROXY = url
      output.env.HTTP_PROXY = url
      output.env.NO_PROXY = "localhost,127.0.0.1"
    },
  }
}
