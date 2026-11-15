import { OcsError } from '@workhub-devices/core';
import { t } from './messages';

const CODE_TEXT: Record<string, () => string> = {
  QUOTA_EXCEEDED: () => t.errQuotaExceeded,
  FILE_TOO_LARGE: () => t.errFileTooLarge,
  FILE_LOCKED: () => t.errFileLocked,
  FILE_GONE: () => t.errFileGone,
  FILE_CHANGED: () => t.errFileChanged,
  FILES_UNSUPPORTED: () => t.errFilesUnsupported,
  TALK_FEATURE_MISSING: () => t.errTalkFeatureMissing,
  TALK_CHAT_FORBIDDEN: () => t.errTalkChatForbidden,
  DOWNLOAD_HIDDEN: () => t.errDownloadHidden,
  OPEN_NOT_ALLOWED: () => t.errOpenNotAllowed,
  INVALID_VOICE_MESSAGE: () => t.errInvalidVoiceMessage,
  NOT_A_FILE: () => t.errNotAFile,
  NAME_EXHAUSTED: () => t.errNameExhausted,
  MIC_DENIED: () => t.errMicDenied,
  PLAYBACK_FAILED: () => t.errPlaybackFailed,
};

/** A user-facing message for any error thrown by the backend, in the active language. */
export function describeError(e: unknown): string {
  if (e instanceof OcsError) {
    const byCode = e.errorCode ? CODE_TEXT[e.errorCode] : undefined;
    if (byCode) return byCode();
    if (e.status === 507) return t.errQuotaExceeded;
    switch (e.kind) {
      case 'aborted':
        return t.errAborted;
      case 'unauthorized':
        return t.errUnauthorized;
      case 'forbidden':
        return e.errorCode?.endsWith('_DISABLED') ? t.errModuleDisabled : t.errForbidden;
      case 'not_found':
        return t.errNotFound;
      case 'conflict':
        return t.errConflict;
      case 'rate_limited':
        return t.errRateLimited(Math.ceil((e.retryAfterMs ?? 60000) / 1000));
      case 'network':
        return t.errNetwork;
      case 'timeout':
        return t.errTimeout;
      case 'redirect':
        return t.errRedirect;
      case 'server':
        return t.errServer;
      default:
        if (e.kind.startsWith('url:')) return urlError(e.kind.slice(4));
        if (e.kind.startsWith('login:')) return loginError(e.kind.slice(6));
        return e.ocsMessage || t.errFailed;
    }
  }
  const err = e as { name?: string; code?: string };
  if (err?.name === 'ServerUrlError') return urlError(err.code ?? '');
  if (err?.name === 'LoginFlowError') return loginError(err.code ?? '');
  return t.errUnexpected;
}

function urlError(code: string): string {
  switch (code) {
    case 'empty':
      return t.urlEmpty;
    case 'insecure':
      return t.urlInsecure;
    case 'userinfo':
      return t.urlUserinfo;
    case 'query':
      return t.urlQuery;
    case 'fragment':
      return t.urlFragment;
    default:
      return t.urlInvalid;
  }
}

function loginError(code: string): string {
  switch (code) {
    case 'cancelled':
      return t.loginCancelled;
    case 'expired':
      return t.loginExpired;
    case 'untrusted_endpoint':
      return t.loginUntrustedEndpoint;
    case 'start_failed':
      return t.loginStartFailed;
    case 'network':
      return t.loginNetwork;
    default:
      return t.loginFailed;
  }
}
