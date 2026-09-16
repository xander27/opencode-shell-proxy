import { execFile, spawn } from "node:child_process"
import { createHash } from "node:crypto"
import { appendFileSync, chmodSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs"
import { createConnection } from "node:net"
import { homedir, platform, arch, tmpdir } from "node:os"
import { join } from "node:path"

const GOST_REPO = "go-gost/gost"
const CACHE_DIR = () => `${homedir()}/.cache/opencode-shell-proxy`
const GOST_BIN = () => join(CACHE_DIR(), "gost")
const SECRET_FILE = () => `${homedir()}/.config/opencode/shell-proxy.env`

const BRIDGE_PORT = () => Number(process.env.OPENCODE_SHELL_PROXY_BRIDGE_PORT) || 18181
const CHECK_URL = () => process.env.OPENCODE_SHELL_PROXY_CHECK_URL || "https://example.com"
const CHECK_TIMEOUT_MS = () => Number(process.env.OPENCODE_SHELL_PROXY_CHECK_TIMEOUT_MS) || 10_000
const RECHECK_MS = () => Number(process.env.OPENCODE_SHELL_PROXY_RECHECK_MS) || 5 * 60_000
const NO_PROXY_LIST = () => process.env.OPENCODE_SHELL_PROXY_NO_PROXY || "localhost,127.0.0.1"

const ARCH_MAP = { x64: "amd64", arm64: "arm64", arm: "armv7", ia32: "386" }
const OS_MAP = { linux: "linux", darwin: "darwin", freebsd: "freebsd" }

const fromFile = () => {
  try {
    const raw = readFileSync(SECRET_FILE(), "utf8").trim()
    if (!raw) return undefined
    const kv = raw.match(/^(?:UPSTREAM|URL|PROXY)=(.+)$/m)
    return (kv ? kv[1] : raw).trim() || undefined
  } catch {
    return undefined
  }
}

const debug = (msg) => {
  if (!process.env.OPENCODE_SHELL_PROXY_DEBUG) return
  try {
    appendFileSync("/tmp/opencode/plugin-debug.log", `${new Date().toISOString()} ${msg}\n`)
  } catch {}
}

const redact = (url) => url.replace(/\/\/[^/@]*@/, "//***@")

const assetName = (tag) => {
  const os = OS_MAP[platform()]
  const cpu = ARCH_MAP[arch()]
  const ext = os === "windows" ? "zip" : "tar.gz"
  if (!os || !cpu) return undefined
  return `gost_${tag}_${os}_${cpu}.${ext}`
}

const sha256 = (path) => createHash("sha256").update(readFileSync(path)).digest("hex")

const portListening = (port, host = "127.0.0.1") =>
  new Promise((resolve) => {
    const s = createConnection({ port, host })
    s.on("connect", () => {
      s.destroy()
      resolve(true)
    })
    s.on("error", () => resolve(false))
  })

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

const run = (cmd, args, opts = {}) =>
  new Promise((resolve) => {
    execFile(cmd, args, { timeout: 30_000, ...opts }, (err, stdout, stderr) =>
      resolve({ ok: !err, stdout, stderr }),
    )
  })

const downloadGost = async () => {
  const release = await fetch(`https://api.github.com/repos/${GOST_REPO}/releases/latest`).then((r) => r.json())
  const tag = String(release.tag_name).replace(/^v/, "")
  const name = assetName(tag)
  if (!name) throw new Error(`unsupported platform ${platform()}/${arch()}`)
  const base = `https://github.com/${GOST_REPO}/releases/download/v${tag}`
  mkdirSync(CACHE_DIR(), { recursive: true })
  const buf = Buffer.from(await fetch(`${base}/${name}`).then((r) => {
    if (!r.ok) throw new Error(`download ${name}: ${r.status}`)
    return r.arrayBuffer()
  }))
  const tgz = join(tmpdir(), name)
  rmSync(tgz, { force: true })
  writeFileSync(tgz, buf)
  const sums = await fetch(`${base}/checksums.txt`).then((r) => r.text())
  const want = sums.split("\n").find((l) => l.trimEnd().endsWith(name))
  const got = sha256(tgz)
  if (!want || want.split(/\s+/)[0] !== got) throw new Error(`checksum mismatch for ${name}`)
  const dir = join(tmpdir(), `gost-extract-${Date.now()}`)
  mkdirSync(dir, { recursive: true })
  await run("tar", ["-xzf", tgz, "-C", dir])
  const extracted = join(dir, "gost")
  chmodSync(extracted, 0o755)
  renameSync(extracted, GOST_BIN())
  rmSync(dir, { recursive: true, force: true })
  rmSync(tgz, { force: true })
  return GOST_BIN()
}

const findGost = async () => {
  for (const candidate of ["gost", join(homedir(), ".local/bin/gost"), "/usr/local/bin/gost", GOST_BIN()]) {
    if (candidate !== "gost" && !existsSync(candidate)) continue
    const r = await run(candidate, ["-V"], { timeout: 5_000 })
    if (r.ok) return candidate
  }
  return downloadGost()
}

const ensureBridge = async (upstream, report) => {
  if (await portListening(BRIDGE_PORT())) return true
  let bin
  try {
    bin = await findGost()
  } catch (e) {
    report("error", `cannot obtain gost: ${e.message}`)
    return false
  }
  spawn(bin, ["-L", `http://127.0.0.1:${BRIDGE_PORT()}`, "-F", upstream.replace(/^socks5h:\/\//, "socks5://")], {
    stdio: "ignore",
    detached: true,
  }).unref()
  for (let i = 0; i < 50; i++) {
    if (await portListening(BRIDGE_PORT())) return true
    await sleep(200)
  }
  report("error", "gost bridge did not start")
  return false
}

export const ProxyPlugin = async ({ client }) => {
  const upstream = process.env.OPENCODE_SHELL_PROXY ?? fromFile()
  if (!upstream) return {}

  const bridged = /^socks5h?:\/\//.test(upstream)
  const proxyUrl = bridged ? `http://127.0.0.1:${BRIDGE_PORT()}` : upstream

  const prev = {}
  for (const k of ["HTTPS_PROXY", "https_proxy", "HTTP_PROXY", "http_proxy"]) prev[k] = process.env[k]

  let available = false
  let reported = false
  let lastCheckAt = 0
  let checking = null
  let proxyActive = false
  let fetchPatched = false

  const report = (level, message) => {
    client?.app?.log({ body: { service: "opencode-shell-proxy", level, message } })?.catch?.(() => {})
  }

  const toast = (message, variant) => {
    client?.tui?.showToast({ body: { title: "shell-proxy", message, variant, duration: 5000 } })?.catch?.(() => {})
  }

  const noProxyHosts = () => new Set(["localhost", "127.0.0.1", "::1", ...NO_PROXY_LIST().split(",").map((s) => s.trim()).filter(Boolean)])

  const patchFetch = () => {
    if (fetchPatched) return
    fetchPatched = true
    const origFetch = globalThis.fetch
    globalThis.fetch = (input, init) => {
      if (!proxyActive) return origFetch(input, init)
      let url = ""
      if (typeof input === "string") url = input
      else if (input instanceof URL) url = input.href
      else if (input && typeof input.url === "string") url = input.url
      if (!/^https?:\/\//i.test(url)) return origFetch(input, init)
      try {
        if (noProxyHosts().has(new URL(url).hostname)) return origFetch(input, init)
      } catch {
        return origFetch(input, init)
      }
      return origFetch(input, { ...init, proxy: proxyUrl })
    }
  }

  const llmOn = () => {
    proxyActive = true
    for (const k of ["HTTPS_PROXY", "https_proxy", "HTTP_PROXY", "http_proxy"]) process.env[k] = proxyUrl
    for (const k of ["NO_PROXY", "no_proxy"]) process.env[k] = NO_PROXY_LIST()
  }

  const sanePrev = (v) => (/^https?:\/\//.test(v) ? v : undefined)

  const llmOff = () => {
    proxyActive = false
    for (const k of ["HTTPS_PROXY", "https_proxy", "HTTP_PROXY", "http_proxy"]) {
      const v = sanePrev(prev[k])
      if (v !== undefined) process.env[k] = v
      else delete process.env[k]
    }
    for (const k of ["NO_PROXY", "no_proxy"]) process.env[k] = NO_PROXY_LIST()
  }

  const check = () => {
    if (checking) return checking
    checking = (async () => {
      if (bridged && !(await portListening(BRIDGE_PORT()))) {
        if (!(await ensureBridge(upstream, report))) return false
      }
      return new Promise((resolve) => {
        execFile(
          "curl",
          [
            "-fsS",
            "-o",
            "/dev/null",
            "-m",
            String(Math.ceil(CHECK_TIMEOUT_MS() / 1000)),
            "--proxy",
            proxyUrl,
            CHECK_URL(),
          ],
          { timeout: CHECK_TIMEOUT_MS() + 2000 },
          (err) => resolve(!err),
        )
      })
    })().then((ok) => {
      checking = null
      lastCheckAt = Date.now()
      if (ok && reported) {
        reported = false
        report("info", `proxy ${redact(proxyUrl)} is back, routing traffic through it`)
        toast("proxy is back online, traffic routed through it", "success")
      } else if (!ok && !reported) {
        reported = true
        report("error", `proxy ${redact(proxyUrl)} failed check against ${CHECK_URL()}, traffic goes direct`)
        toast("shell proxy unreachable — traffic goes direct", "warning")
      }
      if (ok) llmOn()
      else llmOff()
      debug(`check ok=${ok} llmEnv=${process.env.HTTPS_PROXY ?? "(none)"}`)
      available = ok
      return ok
    })
    return checking
  }

  const bridgeUp = await portListening(BRIDGE_PORT())
  debug(`init url=${redact(upstream)} bridged=${bridged} portListening=${bridgeUp}`)
  patchFetch()
  if (!bridged || bridgeUp) llmOn()
  report("info", `initialized, upstream=${redact(upstream)} bridged=${bridged} proxyUrl=${redact(proxyUrl)}`)
  check()

  return {
    "shell.env": async (input, output) => {
      if (Date.now() - lastCheckAt > RECHECK_MS()) await check()
      if (!available) {
        for (const k of ["NO_PROXY", "no_proxy"]) output.env[k] = "*"
        return
      }
      for (const k of ["HTTPS_PROXY", "https_proxy", "HTTP_PROXY", "http_proxy"]) output.env[k] = proxyUrl
      for (const k of ["NO_PROXY", "no_proxy"]) output.env[k] = NO_PROXY_LIST()
    },
  }
}
