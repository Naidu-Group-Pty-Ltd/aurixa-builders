import { useMemo } from 'react';
import { useBrand } from './BrandProvider';

export function useTokens() {
  const { currentTheme, resolvedTokens } = useBrand();

  return useMemo(
    () => (currentTheme === 'dark' ? resolvedTokens.dark : resolvedTokens.light),
    [currentTheme, resolvedTokens.dark, resolvedTokens.light]
  );
}

export { useBrand } from './BrandProvider';