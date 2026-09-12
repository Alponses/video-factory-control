import { useEffect, useMemo, useState } from 'react';
import type { PublicationDto, PublicationPreflightDto } from '@contracts';
import { AdminApiError, adminApi } from '../lib/api';
import { ErrorState, LoadingState } from './States';

interface Props {
  publication: PublicationDto;
  onReload: () => Promise<void>;
  onDirtyChange: (key: string, dirty: boolean) => void;
}

const DEFAULT_TIMEZONE = 'America/Mexico_City';

function blockersText(preflight: PublicationPreflightDto) {
  return preflight.blockers.map((item) => `${item.code}: ${item.message}`);
}

export function ScheduleControls({ publication, onReload, onDirtyChange }: Props) {
  const key = `schedule-${publication.id}`;
  const [preflight, setPreflight] = useState<PublicationPreflightDto | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<unknown>(null);
  const [localDateTime, setLocalDateTime] = useState('');
  const [timezone, setTimezone] = useState(DEFAULT_TIMEZONE);
  const [dirty, setDirty] = useState(false);
  const [busy, setBusy] = useState(false);
  const [conflict, setConflict] = useState(false);

  const load = async () => {
    setLoading(true); setError(null);
    try {
      const result = await adminApi.preflightPublication(publication.id);
      setPreflight(result);
      if (!dirty && result.activeSchedule) {
        setLocalDateTime(result.activeSchedule.localDateTime.slice(0, 16));
        setTimezone(result.activeSchedule.timezone);
      }
    } catch (caught) { setError(caught); }
    finally { setLoading(false); }
  };

  useEffect(() => { void load(); return () => onDirtyChange(key, false); }, [publication.id]);
  useEffect(() => { onDirtyChange(key, dirty); }, [dirty, key, onDirtyChange]);

  const active = preflight?.activeSchedule ?? null;
  const canSubmit = Boolean(localDateTime && timezone && preflight?.ready && !busy);
  const previewLines = useMemo(() => {
    if (!preflight?.preview) return [];
    const item = preflight.preview;
    return [
      `Platform: ${item.platform}`,
      `Title: ${item.title ?? '—'}`,
      `Caption: ${item.caption ?? '—'}`,
      `Hashtags: ${item.hashtags.join(' ') || '—'}`,
      `Durable video: ${item.videoAssetId ?? 'missing'}`,
      `Cover: ${item.coverAssetId ?? '—'}`,
      `Thumbnail: ${item.thumbnailAssetId ?? '—'}`,
    ];
  }, [preflight]);

  const save = async () => {
    if (!canSubmit || !preflight) return;
    setBusy(true); setConflict(false); setError(null);
    try {
      if (active) await adminApi.rescheduleSchedule(active.id, { localDateTime: localDateTime.length === 16 ? `${localDateTime}:00` : localDateTime, timezone, expectedVersion: active.version });
      else await adminApi.schedulePublication(publication.id, { localDateTime: localDateTime.length === 16 ? `${localDateTime}:00` : localDateTime, timezone, expectedVersion: publication.version });
      setDirty(false);
      await onReload();
      await load();
    } catch (caught) {
      if (caught instanceof AdminApiError && caught.status === 409) setConflict(true);
      else setError(caught);
    } finally { setBusy(false); }
  };

  const cancel = async () => {
    if (!active || busy) return;
    if (!window.confirm(`Cancel schedule for ${publication.platform}?`)) return;
    setBusy(true); setConflict(false); setError(null);
    try {
      await adminApi.cancelSchedule(active.id, active.version);
      setDirty(false); setLocalDateTime('');
      await onReload();
      await load();
    } catch (caught) {
      if (caught instanceof AdminApiError && caught.status === 409) setConflict(true);
      else setError(caught);
    } finally { setBusy(false); }
  };

  if (loading && !preflight) return <LoadingState label={`Checking ${publication.platform} preflight…`} />;
  if (error && !preflight) return <ErrorState error={error} action={<button className="button secondary" type="button" onClick={() => void load()}>Retry</button>} />;

  return <section className="schedule-card" aria-label={`${publication.platform} scheduling`}>
    <div className="section-toolbar"><div><h3>Schedule</h3><p className="muted">UTC persistence · IANA timezone · dispatch snapshot at due time.</p></div><span className={preflight?.ready ? 'preflight-ready' : 'preflight-blocked'}>{preflight?.ready ? 'Preflight ready' : 'Preflight blocked'}</span></div>
    {preflight?.latestDispatch ? <div className="info-banner"><strong>This publication has already been dispatched.</strong><p>Dispatch {preflight.latestDispatch.id} is {preflight.latestDispatch.status}. Later editorial edits do not mutate its snapshot.</p></div> : null}
    {preflight && preflight.blockers.length > 0 ? <div className="warning-banner" role="alert"><strong>Blockers</strong><ul>{blockersText(preflight).map((message) => <li key={message}>{message}</li>)}</ul></div> : null}
    {preflight && preflight.warnings.length > 0 ? <div className="info-banner"><strong>Warnings</strong><ul>{preflight.warnings.map((item) => <li key={item.code}>{item.message}</li>)}</ul></div> : null}
    <div className="schedule-form-grid">
      <label>Date and time<input aria-label={`${publication.platform} schedule date and time`} type="datetime-local" value={localDateTime} onChange={(event) => { setLocalDateTime(event.target.value); setDirty(true); }} /></label>
      <label>Timezone<input aria-label={`${publication.platform} timezone`} value={timezone} onChange={(event) => { setTimezone(event.target.value); setDirty(true); }} placeholder="America/Mexico_City" /></label>
    </div>
    <details className="schedule-preview"><summary>Preview what will publish</summary><ul>{previewLines.map((line) => <li key={line}>{line}</li>)}</ul><p><strong>Scheduled local time:</strong> {localDateTime || 'not selected'} {timezone}</p>{preflight?.preview ? <p className="muted">{preflight.preview.internalRuleNotice}</p> : null}</details>
    {conflict ? <div className="warning-banner" role="alert"><strong>Schedule changed since you loaded it.</strong><p>No automatic retry was attempted.</p><div className="action-cluster"><button className="button secondary" type="button" onClick={() => { setConflict(false); void load(); }}>Reload latest version</button><button className="button secondary" type="button" onClick={() => setConflict(false)}>Keep my unsaved changes</button></div></div> : null}
    {error && preflight ? <ErrorState error={error} /> : null}
    <div className="action-cluster"><button className="button" type="button" disabled={!canSubmit} onClick={() => void save()}>{busy ? 'Saving…' : active ? 'Reschedule' : 'Schedule'}</button>{active ? <button className="button secondary" type="button" disabled={busy} onClick={() => void cancel()}>Cancel schedule</button> : null}<button className="button secondary" type="button" disabled={busy} onClick={() => void load()}>Refresh preflight</button></div>
  </section>;
}
