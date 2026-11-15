import { createHash } from 'node:crypto';
import type { HashPolicy } from '../types.js';
import { normalizePhone } from './phone.js';

export function hashPhone(rawPhone: string, policy: HashPolicy): string {
  const phone = normalizePhone(rawPhone);
  const digest = createHash(policy.algorithm)
    .update(`${policy.salt}${phone}`, 'utf8')
    .digest('hex');
  return policy.uppercase ? digest.toUpperCase() : digest;
}

export function hashHexLength(policy: HashPolicy): number {
  return policy.algorithm === 'md5' ? 32 : 64;
}

export function validateHashFormat(hash: string, policy: HashPolicy): boolean {
  if (!new RegExp(`^[0-9a-fA-F]{${hashHexLength(policy)}}$`).test(hash)) return false;
  const isUpper = hash === hash.toUpperCase();
  const isLower = hash === hash.toLowerCase();
  return policy.uppercase ? isUpper : isLower;
}
