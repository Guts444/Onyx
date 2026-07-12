const REDACTED_VALUE = "redacted";
const SENSITIVE_QUERY_KEY = /^(?:access_?token|api_?key|auth|authorization|credential|key|pass|password|secret|signature|token|user|username)$/i;
const XTREAM_PATH_KIND = /^(?:live|movie|series)$/i;
const EMBEDDED_URL = /[a-z][a-z0-9+.-]*:\/\/[^\s"'<>]+/gi;

export function redactCredentialUrl(value: string) {
  let url: URL;

  try {
    url = new URL(value);
  } catch {
    return value;
  }

  if (url.username) {
    url.username = REDACTED_VALUE;
  }
  if (url.password) {
    url.password = REDACTED_VALUE;
  }

  const pathSegments = url.pathname.split("/");
  const xtreamKindIndex = pathSegments.findIndex((segment) => XTREAM_PATH_KIND.test(segment));
  if (xtreamKindIndex >= 0 && pathSegments.length > xtreamKindIndex + 3) {
    pathSegments[xtreamKindIndex + 1] = REDACTED_VALUE;
    pathSegments[xtreamKindIndex + 2] = REDACTED_VALUE;
    url.pathname = pathSegments.join("/");
  }

  for (const key of Array.from(url.searchParams.keys())) {
    if (SENSITIVE_QUERY_KEY.test(key)) {
      url.searchParams.set(key, REDACTED_VALUE);
    }
  }

  return url.href;
}

export function redactCredentials(value: string) {
  return value.replace(EMBEDDED_URL, (matchedUrl) => {
    let url = matchedUrl;
    let trailing = "";

    while (/[),.;!?]$/.test(url)) {
      trailing = `${url.slice(-1)}${trailing}`;
      url = url.slice(0, -1);
    }

    return `${redactCredentialUrl(url)}${trailing}`;
  });
}
