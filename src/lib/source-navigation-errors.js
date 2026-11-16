import { navigationDiagnostic } from './navigation-diagnostics.js';

const NETWORK_ERRORS = new Set([
  'ERR_TIMED_OUT', 'ERR_CONNECTION_TIMED_OUT', 'ERR_CONNECTION_CLOSED',
  'ERR_CONNECTION_RESET', 'ERR_CONNECTION_ABORTED', 'ERR_CONNECTION_REFUSED', 'ERR_CONNECTION_FAILED',
  'ERR_NAME_NOT_RESOLVED', 'ERR_NAME_RESOLUTION_FAILED', 'ERR_INTERNET_DISCONNECTED',
  'ERR_NETWORK_CHANGED', 'ERR_PROXY_CONNECTION_FAILED', 'ERR_TUNNEL_CONNECTION_FAILED',
  'ERR_EMPTY_RESPONSE', 'ERR_ADDRESS_UNREACHABLE', 'ERR_SOCKET_NOT_CONNECTED',
  'ERR_HTTP2_PROTOCOL_ERROR', 'ERR_QUIC_PROTOCOL_ERROR',
]);
const UNAVAILABLE_ERRORS = new Set(['ERR_FAILED', 'ERR_HTTP_RESPONSE_CODE_FAILURE']);
const SECURITY_ERRORS = new Set([
  'ERR_ACCESS_DENIED', 'ERR_BLOCKED_BY_CLIENT', 'ERR_BLOCKED_BY_ADMINISTRATOR',
  'ERR_BLOCKED_BY_RESPONSE', 'ERR_BLOCKED_BY_CSP', 'ERR_UNSAFE_REDIRECT', 'ERR_UNSAFE_PORT',
  'ERR_CERT_COMMON_NAME_INVALID', 'ERR_CERT_DATE_INVALID', 'ERR_CERT_AUTHORITY_INVALID',
  'ERR_CERT_INVALID', 'ERR_CERT_REVOKED', 'ERR_CERT_CONTAINS_ERRORS',
  'ERR_CERT_NO_REVOCATION_MECHANISM', 'ERR_CERT_UNABLE_TO_CHECK_REVOCATION',
  'ERR_CERT_WEAK_SIGNATURE_ALGORITHM', 'ERR_CERT_NAME_CONSTRAINT_VIOLATION',
  'ERR_CERT_VALIDITY_TOO_LONG', 'ERR_SSL_PROTOCOL_ERROR', 'ERR_SSL_VERSION_OR_CIPHER_MISMATCH',
  'ERR_SSL_CLIENT_AUTH_CERT_NEEDED', 'ERR_SSL_CLIENT_AUTH_PRIVATE_KEY_ACCESS_DENIED',
  'ERR_PROXY_CERTIFICATE_INVALID', 'ERR_PROXY_AUTH_REQUESTED', 'ERR_PROXY_AUTH_UNSUPPORTED',
  'ERR_INVALID_AUTH_CREDENTIALS', 'ERR_MISSING_AUTH_CREDENTIALS', 'ERR_TOO_MANY_REDIRECTS',
  'ERR_DISALLOWED_URL_SCHEME', 'ERR_INVALID_URL', 'ERR_UNKNOWN_URL_SCHEME',
]);

/** Keep only known browser codes; arbitrary exception text never enters a report. */
export function navigationErrorCode(value) {
  if (typeof value !== 'string') return undefined;
  const code = value.startsWith('net::') ? value.slice(5) : value;
  return NETWORK_ERRORS.has(code) || SECURITY_ERRORS.has(code) || UNAVAILABLE_ERRORS.has(code) || code === 'ERR_ABORTED' ? `net::${code}` : undefined;
}

export function navigationErrorState(value) {
  const code = navigationErrorCode(value)?.slice(5);
  return code === 'ERR_ABORTED' ? 'interrupted' : NETWORK_ERRORS.has(code) ? 'network_error'
    : SECURITY_ERRORS.has(code) ? 'security_error' : 'unavailable';
}

export function navigationStopMessage(navigation) {
  const messages = {
    navigation_after_commit: 'Страница книги была повторно перезагружена во время сбора. Начните сбор заново.',
    unexpected_document: 'Не удалось подтвердить документ страницы книги. Начните сбор заново.',
    legacy_transition: 'Обновление расширения прервало текущий переход. Начните сбор книги заново.',
  };
  const cause = typeof navigation?.cause === 'string' ? navigation.cause : '';
  return Object.hasOwn(messages, cause) ? messages[cause] : '';
}

export function sourceStatusError(status) {
  const messages = {
    loading: ['source_loading', 'Книга ещё загружается. Ожидаем завершения перехода.'],
    network_error: ['source_network_error', 'Не удалось загрузить страницу книги. Проверьте соединение или VPN и повторите сбор.'],
    security_error: ['source_security_error', status.reason === 'login_required'
      ? 'Учебная платформа просит войти в аккаунт. Войдите и повторите сбор книги.'
      : 'Браузер или учебная платформа заблокировали загрузку страницы книги. Проверьте исходную вкладку.'],
    interrupted: ['source_interrupted', 'Загрузка страницы книги была прервана. Проверьте исходную вкладку и повторите сбор.'],
    unavailable: ['source_unavailable', 'Страница книги недоступна. Проверьте её загрузку в исходной вкладке и повторите сбор.'],
    closed: ['source_closed', 'Вкладка с учебником закрыта. Откройте нужную книгу и нажмите значок расширения.'],
    other_book: ['source_changed', 'В исходной вкладке открыта другая книга. Верните выбранную книгу и повторите сбор.'],
    source_changed: ['source_left_page', 'В исходной вкладке открыта другая страница. Верните выбранную книгу и повторите сбор.'],
  };
  let [code, message] = messages[status.state] || messages.unavailable;
  const navigation = navigationDiagnostic(status.navigation);
  const expectedUrl = status.expectedUrl || navigation?.expectedUrl;
  const observedUrl = status.url || navigation?.observedUrl;
  if (navigation?.cause === 'legacy_transition') code = 'source_update_required';
  if (['source_changed', 'unavailable'].includes(status.state)) message = navigationStopMessage(navigation) || message;
  return Object.assign(new Error(message), { code,
    ...(navigation ? { navigation } : {}),
    ...(navigationErrorCode(status.networkError) ? { networkError: navigationErrorCode(status.networkError) } : {}),
    ...(expectedUrl ? { expectedUrl } : {}), ...(observedUrl ? { observedUrl } : {}),
    ...(Number.isSafeInteger(status.attempt) && status.attempt > 0 ? { attempt: status.attempt } : {}) });
}
