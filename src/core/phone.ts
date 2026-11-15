/** Normalize a mainland-China phone number to 11 digits (1xxxxxxxxxx). */
export function normalizePhone(raw: string): string {
  const digits = String(raw ?? '').replace(/\D/g, '');
  if (digits.length === 13 && digits.startsWith('86')) return digits.slice(2);
  if (digits.length === 14 && digits.startsWith('0086')) return digits.slice(4);
  return digits;
}

export function isValidPhone(raw: string): boolean {
  return /^1[3-9]\d{9}$/.test(normalizePhone(raw));
}

export function maskPhone(raw: string): string {
  const phone = normalizePhone(raw);
  if (phone.length !== 11) return '***';
  return `${phone.slice(0, 3)}****${phone.slice(7)}`;
}
