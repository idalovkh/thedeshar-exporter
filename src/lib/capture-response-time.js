export function responseTime(value) {
  if (typeof value !== 'string') return null;
  const parts = value.match(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.(\d{1,9}))?(?:Z|[+-]\d{2}:\d{2})$/);
  if (!parts) return null;
  const milliseconds = Date.parse(value.replace(/\.\d+(?=Z|[+-])/, ''));
  return Number.isFinite(milliseconds) ? BigInt(milliseconds) * 1000000n + BigInt((parts[1] || '').padEnd(9, '0')) : null;
}

