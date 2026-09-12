export function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let value = bytes;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  const fixed = value < 10 && unit > 0 ? value.toFixed(2) : value < 100 ? value.toFixed(1) : value.toFixed(0);
  return `${fixed} ${units[unit]}`;
}
