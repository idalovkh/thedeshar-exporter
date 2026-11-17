import { redactSensitive } from './security.js';
import { navigationBlockReason } from './navigation-block-reasons.js';

const nonnegativeInteger = value => Number.isSafeInteger(value) && value >= 0;
const lessonButtonCauses = new Set(['missing', 'multiple', 'disabled', 'label', 'icon', 'identity']);
const boundedCount = value => nonnegativeInteger(value) && value <= 1000;

function lessonButtonDiagnostic(value, blockedReasonCode) {
  if (!value || typeof value !== 'object' || Array.isArray(value) ||
      !boundedCount(value.cardIndex) || value.cardIndex === 0 ||
      !boundedCount(value.desktopVisible) || !boundedCount(value.mobileVisible) ||
      !lessonButtonCauses.has(value.cause) ||
      !(blockedReasonCode === 'lesson_button' || blockedReasonCode === 'invalid_item' && value.cause === 'disabled')) return null;
  const { cardIndex, desktopVisible, mobileVisible, cause } = value;
  return { cardIndex, desktopVisible, mobileVisible, cause };
}

export function pageReadinessDiagnostic(value) {
  const diagnostic = {};
  if (value?.reason === 'navigation_blocked') {
    const blockedReasonCode = navigationBlockReason(value.blockedReasonCode);
    if (blockedReasonCode) diagnostic.blockedReasonCode = blockedReasonCode;
    const lessonButton = lessonButtonDiagnostic(value.lessonButton, blockedReasonCode);
    if (lessonButton) diagnostic.lessonButton = lessonButton;
  }
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
