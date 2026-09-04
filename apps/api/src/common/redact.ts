const URL_PATTERN = /\b(?:wss?|https?):\/\/[^\s"'<>]+/gi;

/**
 * Reduces every URL in a message to scheme and host. RPC URLs routinely carry API keys in their
 * path, query or userinfo, and library error messages embed the full URL.
 */
export function redactUrlSecrets(text: string): string {
  return text.replace(URL_PATTERN, (match) => {
    try {
      const url = new URL(match);
      return `${url.protocol}//${url.host}`;
    } catch {
      return `${match.split("://")[0]}://<redacted>`;
    }
  });
}
