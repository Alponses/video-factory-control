import { useEffect, useMemo, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import type { CalendarItemDto, CalendarDto, PlatformDto, ScheduleStatusDto } from '@contracts';
import { EmptyState, ErrorState, LoadingState } from '../components/States';
import { AdminApiError, adminApi } from '../lib/api';
import { useUnsavedChanges } from '../hooks/useUnsavedChanges';

const platforms = ['', 'TIKTOK', 'YOUTUBE', 'FACEBOOK'] as const;
const statuses = ['', 'SCHEDULED', 'DISPATCHED', 'CANCELLED', 'SUPERSEDED'] as const;

type ViewMode = 'month' | 'week';

function dateKey(date: Date) { return date.toISOString().slice(0, 10); }
function addDays(date: Date, days: number) { const copy = new Date(date); copy.setUTCDate(copy.getUTCDate() + days); return copy; }
function startOfWeek(date: Date) { const day = date.getUTCDay(); return addDays(date, -(day === 0 ? 6 : day - 1)); }
function parseDate(value: string | null) { const parsed = value && /^\d{4}-\d{2}-\d{2}$/.test(value) ? new Date(`${value}T00:00:00.000Z`) : new Date(); return Number.isNaN(parsed.getTime()) ? new Date() : parsed; }
function platformLabel(platform: PlatformDto) { return platform === 'TIKTOK' ? 'TikTok' : platform === 'YOUTUBE' ? 'YouTube' : 'Facebook'; }

export function CalendarPage() {
  const [params, setParams] = useSearchParams();
  const view: ViewMode = params.get('view') === 'week' ? 'week' : 'month';
  const anchor = parseDate(params.get('date'));
  const [data, setData] = useState<CalendarDto | null>(null);
  const [error, setError] = useState<unknown>(null);
  const [loading, setLoading] = useState(true);
  const [selected, setSelected] = useState<CalendarItemDto | null>(null);
  const [editLocal, setEditLocal] = useState('');
  const [editTimezone, setEditTimezone] = useState('');
  const [dirty, setDirty] = useState(false);
  const [conflict, setConflict] = useState(false);
  const [busy, setBusy] = useState(false);
  useUnsavedChanges(dirty);

  const range = useMemo(() => {
    if (view === 'week') {
      const start = startOfWeek(anchor); return { start, end: addDays(start, 7), days: Array.from({ length: 7 }, (_, index) => addDays(start, index)) };
    }
    const start = new Date(Date.UTC(anchor.getUTCFullYear(), anchor.getUTCMonth(), 1));
    const end = new Date(Date.UTC(anchor.getUTCFullYear(), anchor.getUTCMonth() + 1, 1));
    const days = Array.from({ length: Math.round((end.getTime() - start.getTime()) / 86_400_000) }, (_, index) => addDays(start, index));
    return { start, end, days };
  }, [view, params.get('date')]);

  const load = async () => {
    setLoading(true); setError(null);
    const query = new URLSearchParams({ start: range.start.toISOString(), end: range.end.toISOString() });
    const platform = params.get('platform'); const status = params.get('status'); const channelId = params.get('channelId');
    if (platform) query.set('platform', platform); if (status) query.set('status', status); if (channelId) query.set('channelId', channelId);
    try { setData(await adminApi.calendar(query)); } catch (caught) { setError(caught); } finally { setLoading(false); }
  };
  useEffect(() => { void load(); }, [range.start.getTime(), range.end.getTime(), params.get('platform'), params.get('status'), params.get('channelId')]);

  const updateParam = (key: string, value: string) => { const next = new URLSearchParams(params); if (value) next.set(key, value); else next.delete(key); setParams(next); };
  const move = (direction: number) => { const next = new Date(anchor); if (view === 'month') next.setUTCMonth(next.getUTCMonth() + direction); else next.setUTCDate(next.getUTCDate() + direction * 7); updateParam('date', dateKey(next)); };
  const choose = (item: CalendarItemDto) => { setSelected(item); setEditLocal(item.localDateTime.slice(0, 16)); setEditTimezone(item.timezone); setDirty(false); setConflict(false); };
  const eventsFor = (date: Date) => (data?.items ?? []).filter((item) => item.localDateTime.slice(0, 10) === dateKey(date));

  const reschedule = async () => {
    if (!selected) return; setBusy(true); setConflict(false);
    try {
      await adminApi.rescheduleSchedule(selected.scheduleId, { localDateTime: editLocal.length === 16 ? `${editLocal}:00` : editLocal, timezone: editTimezone, expectedVersion: selected.version });
      setDirty(false); setSelected(null); await load();
    } catch (caught) { if (caught instanceof AdminApiError && caught.status === 409) setConflict(true); else setError(caught); }
    finally { setBusy(false); }
  };
  const cancel = async () => {
    if (!selected || !window.confirm('Cancel this schedule?')) return; setBusy(true); setConflict(false);
    try { await adminApi.cancelSchedule(selected.scheduleId, selected.version); setDirty(false); setSelected(null); await load(); }
    catch (caught) { if (caught instanceof AdminApiError && caught.status === 409) setConflict(true); else setError(caught); }
    finally { setBusy(false); }
  };

  return <section className="page-section calendar-page">
    <div className="page-heading"><div><p className="eyebrow">Distribution planning</p><h1>Calendar</h1><p>Schedules are stored as UTC instants while each event retains its original IANA timezone.</p></div></div>
    <div className="calendar-toolbar" aria-label="Calendar controls">
      <div className="segmented"><button type="button" className={view === 'month' ? 'active' : ''} onClick={() => updateParam('view', 'month')}>Month</button><button type="button" className={view === 'week' ? 'active' : ''} onClick={() => updateParam('view', 'week')}>Week</button></div>
      <div className="action-cluster"><button className="button secondary" type="button" onClick={() => move(-1)}>Previous</button><button className="button secondary" type="button" onClick={() => updateParam('date', dateKey(new Date()))}>Today</button><button className="button secondary" type="button" onClick={() => move(1)}>Next</button></div>
      <label>Platform<select value={params.get('platform') ?? ''} onChange={(event) => updateParam('platform', event.target.value)}>{platforms.map((item) => <option key={item || 'all'} value={item}>{item ? platformLabel(item as PlatformDto) : 'All'}</option>)}</select></label>
      <label>Status<select value={params.get('status') ?? ''} onChange={(event) => updateParam('status', event.target.value)}>{statuses.map((item) => <option key={item || 'all'} value={item}>{item || 'All'}</option>)}</select></label>
      <label>Channel<input value={params.get('channelId') ?? ''} placeholder="channel id" onChange={(event) => updateParam('channelId', event.target.value)} /></label>
    </div>
    <h2 className="calendar-period">{view === 'month' ? anchor.toLocaleString('en', { month: 'long', year: 'numeric', timeZone: 'UTC' }) : `Week of ${dateKey(range.days[0]!)}`}</h2>
    {error ? <ErrorState error={error} action={<button className="button secondary" type="button" onClick={() => void load()}>Retry</button>} /> : null}
    {loading ? <LoadingState label="Loading calendar…" /> : null}
    {!loading && !error && data?.items.length === 0 ? <EmptyState title="No scheduled publications." /> : null}
    {!loading && !error && data && data.items.length > 0 ? <div className={`calendar-grid ${view}`} role="grid" aria-label={`${view} publication calendar`}>{range.days.map((day) => <section className="calendar-day" role="gridcell" key={dateKey(day)}><header><time dateTime={dateKey(day)}>{day.getUTCDate()}<span>{day.toLocaleString('en', { weekday: 'short', timeZone: 'UTC' })}</span></time></header><div className="calendar-events">{eventsFor(day).map((item) => <button type="button" className={`calendar-event platform-${item.platform.toLowerCase()}`} key={item.scheduleId} onClick={() => choose(item)}><span className="event-platform">{platformLabel(item.platform)}</span><strong>{item.localDateTime.slice(11, 16)} · {item.title}</strong><span>{item.status} · {item.timezone}</span></button>)}</div></section>)}</div> : null}
    {selected ? <aside className="calendar-detail" aria-label="Schedule details"><div className="section-toolbar"><div><p className="eyebrow">{platformLabel(selected.platform)}</p><h2>{selected.title}</h2></div><button type="button" className="button secondary" onClick={() => { setSelected(null); setDirty(false); }}>Close</button></div><dl className="detail-grid"><div><dt>Status</dt><dd>{selected.status}</dd></div><div><dt>Publication</dt><dd>{selected.publicationStatus}</dd></div><div><dt>UTC instant</dt><dd>{selected.scheduledAtUtc}</dd></div><div><dt>Timezone</dt><dd>{selected.timezone}</dd></div></dl><Link className="button secondary" to={`/videos/${encodeURIComponent(selected.videoId)}?tab=publication`}>Open video</Link>{selected.status === 'SCHEDULED' ? <div className="schedule-form-grid"><label>Date and time<input type="datetime-local" value={editLocal} onChange={(event) => { setEditLocal(event.target.value); setDirty(true); }} /></label><label>Timezone<input value={editTimezone} onChange={(event) => { setEditTimezone(event.target.value); setDirty(true); }} /></label></div> : null}{conflict ? <div className="warning-banner" role="alert"><strong>Schedule version conflict.</strong><p>No automatic retry was attempted.</p><button className="button secondary" type="button" onClick={() => { setConflict(false); setDirty(false); setSelected(null); void load(); }}>Reload latest</button></div> : null}{selected.status === 'SCHEDULED' ? <div className="action-cluster"><button className="button" type="button" disabled={busy || !editLocal || !editTimezone} onClick={() => void reschedule()}>Save schedule</button><button className="button secondary" type="button" disabled={busy} onClick={() => void cancel()}>Cancel schedule</button></div> : <div className="info-banner">This schedule is {selected.status} and cannot be edited directly.</div>}</aside> : null}
  </section>;
}
