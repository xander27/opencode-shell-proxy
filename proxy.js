import { readFileSync } from "node:fs"
import { homedir } from "node:os"

const DEFAULT_URL = "http://127.0.0.1:8080"
const SECRET_FILE = () => `${homedir()}/.config/opencode/shell-proxy.env`

const fromFile = () => {
  try {
    const url = readFileSync(SECRET_FILE(), "utf8").trim()
    return url || undefined
  } catch {
    return undefined
  }
}

export const ProxyPlugin = async () => {
  const url = process.env.OPENCODE_SHELL_PROXY ?? fromFile() ?? DEFAULT_URL
  return {
    "shell.env": async (input, output) => {
      output.env.HTTPS_PROXY = url
      output.env.HTTP_PROXY = url
      output.env.NO_PROXY = "localhost,127.0.0.1"
    },
  }
}
