import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { VIDEO_STATUSES, type AdminDashboardDto } from '@contracts';
import { EmptyState, ErrorState, LoadingState } from '../components/States';
import { StatusBadge } from '../components/Status';
import { adminApi } from '../lib/api';

export function DashboardPage() {
  const [data, setData] = useState<AdminDashboardDto | null>(null);
  const [error, setError] = useState<unknown>(null);

  useEffect(() => {
    let alive = true;
    adminApi.dashboard().then((result) => { if (alive) setData(result); }).catch((caught) => { if (alive) setError(caught); });
    return () => { alive = false; };
  }, []);

  if (error) return <ErrorState error={error} />;
  if (!data) return <LoadingState label="Loading dashboard…" />;

  return (
    <section className="page-section">
      <div className="page-heading"><div><p className="eyebrow">Video Factory</p><h1>Resumen</h1><p>Estado real del catálogo persistido en MariaDB.</p></div><Link className="button secondary" to="/videos">Open video library</Link></div>
      {data.legacyIncomplete > 0 ? <div className="warning-banner" role="status"><strong>Legacy incomplete:</strong> {data.legacyIncomplete} video(s) preserve incomplete historical data. No missing scenes are fabricated.</div> : null}
      <div className="metric-grid">
        <article className="metric-card"><span>Total videos</span><strong>{data.totalVideos}</strong></article>
        {VIDEO_STATUSES.map((status) => <article className="metric-card" key={status}><span>{status}</span><strong>{data.totalsByStatus[status] ?? 0}</strong></article>)}
        <article className="metric-card legacy"><span>Legacy incomplete</span><strong>{data.legacyIncomplete}</strong></article>
      </div>
      <div className="dashboard-grid">
        <section className="panel"><div className="panel-heading"><h2>Últimos videos</h2><Link to="/videos">View all</Link></div>
          {data.recentVideos.length === 0 ? <EmptyState title="No videos yet" /> : <div className="stack-list">{data.recentVideos.map((video) => <Link className="stack-row" to={`/videos/${encodeURIComponent(video.id)}`} key={video.id}><div><strong>{video.title}</strong><span>{video.id} · {video.category}</span></div><div className="row-end"><StatusBadge status={video.status} />{video.legacyIncomplete ? <span className="legacy-flag">Legacy incomplete</span> : null}</div></Link>)}</div>}
        </section>
        <section className="panel"><div className="panel-heading"><h2>Últimos eventos</h2></div>
          {data.recentEvents.length === 0 ? <EmptyState title="No events recorded" /> : <div className="stack-list">{data.recentEvents.map((event) => <Link className="stack-row" to={`/videos/${encodeURIComponent(event.videoId)}?tab=history`} key={event.id}><div><strong>{event.type}</strong><span>{event.videoId}</span></div><time dateTime={event.createdAt}>{new Date(event.createdAt).toLocaleString()}</time></Link>)}</div>}
        </section>
      </div>
      <section className="panel future-panel"><h2>Workers</h2><p>Disponible en Fase 4. No worker data is simulated in this phase.</p></section>
    </section>
  );
}
