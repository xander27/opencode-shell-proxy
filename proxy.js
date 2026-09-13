export const ProxyPlugin = async () => {
  const url = process.env.OPENCODE_SHELL_PROXY ?? "http://127.0.0.1:8080"
  return {
    "shell.env": async (input, output) => {
      output.env.HTTPS_PROXY = url
      output.env.HTTP_PROXY = url
      output.env.NO_PROXY = "localhost,127.0.0.1"
    },
  }
}
