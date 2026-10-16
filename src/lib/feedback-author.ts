/** Public display fallback for an older feedback RPC until the name migration is applied. */
export function feedbackForumName(raw: string | null): string | null {
  const name = raw?.trim();
  if (!name || /[^\s@]+@[^\s@]+/.test(name) || /^0x[0-9a-f]{6,}$/i.test(name) || /^0x[0-9a-f]+(?:\.{2,3}|…)[0-9a-f]+$/i.test(name)) return null;
  return name;
}
