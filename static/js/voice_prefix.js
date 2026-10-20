/** A clone prefix that is valid upstream and readable as a local timestamp. */
export function voicePrefixFor(now = new Date()) {
  return [now.getMonth() + 1, now.getDate(), now.getHours(), now.getMinutes()]
    .map((part) => String(part).padStart(2, '0'))
    .join('');
}
