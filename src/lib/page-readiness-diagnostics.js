import { redactSensitive } from './security.js';

const nonnegativeInteger = value => Number.isSafeInteger(value) && value >= 0;

export function pageReadinessDiagnostic(value) {
  const diagnostic = {};
  if (typeof value?.readinessReason === 'string') {
    const text = value.readinessReason.slice(0, 1000).replace(/[\p{Cc}\p{Cf}]/gu, ' ').replace(/\s+/g, ' ')
      .replace(/(?:\b(?:https?|wss):)?\/\/[^\s<>"']+/gi, '[REDACTED]')
      .replace(/\b[^\s@]+@[^\s@]+\.[^\s@]+\b/g, '[REDACTED]');
    const reason = redactSensitive(text).trim().slice(0, 500);
    if (reason) diagnostic.readinessReason = reason;
  }
  const state = value?.bookState;
  if (state && typeof state === 'object' && !Array.isArray(state) && nonnegativeInteger(state.visibleLessons)) {
    diagnostic.bookState = { visibleLessons: state.visibleLessons };
    if (nonnegativeInteger(state.expectedLessons)) diagnostic.bookState.expectedLessons = state.expectedLessons;
  }
  return diagnostic;
}
