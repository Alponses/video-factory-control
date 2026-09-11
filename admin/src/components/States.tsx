import type { ReactNode } from 'react';
import { AdminApiError } from '../lib/api';

export function LoadingState({ label = 'Loading…' }: { label?: string }) {
  return <div className="state-panel" role="status" aria-live="polite"><span className="skeleton-dot" aria-hidden="true" />{label}</div>;
}

export function EmptyState({ title, children }: { title: string; children?: ReactNode }) {
  return <div className="state-panel"><strong>{title}</strong>{children ? <div className="state-detail">{children}</div> : null}</div>;
}

function errorCopy(error: AdminApiError): { title: string; detail: string } {
  if (error.status === 401) return { title: 'Access session invalid', detail: 'Cloudflare Access authentication is missing or expired. Refresh after restoring your Access session.' };
  if (error.status === 403) return { title: 'Access denied', detail: 'Your authenticated identity is not allowed to use this admin.' };
  if (error.status === 404) return { title: 'Not found', detail: 'The requested resource does not exist.' };
  if (error.status === 429) return { title: 'Too many requests', detail: 'Too many requests, retry shortly.' };
  if (error.status >= 500) return { title: 'Server error', detail: 'The admin API could not complete this request.' };
  return { title: 'Request failed', detail: error.message };
}

export function ErrorState({ error, action }: { error: unknown; action?: ReactNode }) {
  const apiError = error instanceof AdminApiError ? error : new AdminApiError(500, 'CLIENT_ERROR', 'Unexpected client error');
  const copy = errorCopy(apiError);
  return (
    <div className="state-panel state-error" role="alert">
      <strong>{copy.title}</strong>
      <div className="state-detail">{copy.detail}</div>
      {apiError.requestId ? <div className="request-id">Request ID: <code>{apiError.requestId}</code></div> : null}
      {action ? <div className="state-actions">{action}</div> : null}
    </div>
  );
}

export function FieldValue({ value }: { value: string | number | boolean | null | undefined }) {
  if (value === null || value === undefined || value === '') return <span className="muted">No disponible</span>;
  return <span>{typeof value === 'boolean' ? (value ? 'Yes' : 'No') : value}</span>;
}
