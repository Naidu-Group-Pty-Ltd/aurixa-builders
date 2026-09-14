/**
 * Smart capitalization for names.
 * Handles common patterns: McDonald, O'Brien, de la Cruz, etc.
 */

const LOWERCASE_PARTICLES = new Set(['de', 'del', 'di', 'da', 'dos', 'das', 'von', 'van', 'der', 'den', 'la', 'le', 'les', 'al']);
const MC_MAC_PATTERN = /^(mc|mac)(.+)$/i;

function capitalizeWord(word: string, isFirstWord: boolean): string {
  if (!word) return word;
  
  const lower = word.toLowerCase();
  
  // Handle lowercase particles (only if not first word)
  if (!isFirstWord && LOWERCASE_PARTICLES.has(lower)) {
    return lower;
  }
  
  // Handle Mc/Mac prefixes: McDonald, MacGregor
  const mcMatch = lower.match(MC_MAC_PATTERN);
  if (mcMatch) {
    const prefix = mcMatch[1].charAt(0).toUpperCase() + mcMatch[1].slice(1).toLowerCase();
    const rest = mcMatch[2].charAt(0).toUpperCase() + mcMatch[2].slice(1).toLowerCase();
    return prefix + rest;
  }
  
  // Handle O' prefix: O'Brien, O'Connor
  if (lower.startsWith("o'") && lower.length > 2) {
    return "O'" + lower.charAt(2).toUpperCase() + lower.slice(3).toLowerCase();
  }
  
  // Handle hyphenated names: Smith-Jones
  if (word.includes('-')) {
    return word.split('-').map((part, i) => capitalizeWord(part, i === 0 && isFirstWord)).join('-');
  }
  
  // Standard title case
  return word.charAt(0).toUpperCase() + word.slice(1).toLowerCase();
}

export function smartCapitalize(name: string | null | undefined): string {
  if (!name) return '';
  return name
    .trim()
    .split(/\s+/)
    .map((word, index) => capitalizeWord(word, index === 0))
    .join(' ');
}

export function smartCapitalizeFull(firstName?: string | null, surname?: string | null): string {
  const parts = [
    smartCapitalize(firstName),
    smartCapitalize(surname),
  ].filter(Boolean);
  return parts.join(' ');
}