export function hashString(source: string) {
  let hash = 0;

  for (const character of source) {
    hash = (hash << 5) - hash + character.charCodeAt(0);
    hash |= 0;
  }

  return Math.abs(hash).toString(36);
}
