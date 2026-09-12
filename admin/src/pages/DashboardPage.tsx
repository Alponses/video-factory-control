import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { VIDEO_STATUSES, type AdminDashboardDto } from '@contracts';
import { EmptyState, ErrorState, LoadingState } from '../components/States';
import { StatusBadge } from '../components/Status';
import { adminApi } from '../lib/api';
import type { WorkerListView } from '../types/worker';

export function DashboardPage() {
  const [data, setData] = useState<AdminDashboardDto | null>(null);
  const [workers, setWorkers] = useState<WorkerListView | null>(null);
  const [error, setError] = useState<unknown>(null);

  useEffect(() => {
    let alive = true;
    Promise.all([adminApi.dashboard(), adminApi.workers()])
      .then(([dashboard, workerList]) => { if (alive) { setData(dashboard); setWorkers(workerList); } })
      .catch((caught) => { if (alive) setError(caught); });
    return () => { alive = false; };
  }, []);

  if (error) return <ErrorState error={error} />;
  if (!data || !workers) return <LoadingState label="Loading dashboard…" />;

  const workersOnline = workers.items.filter((worker) => worker.effectiveStatus === 'ONLINE' || worker.effectiveStatus === 'BUSY').length;
  const workersBusy = workers.items.filter((worker) => worker.effectiveStatus === 'BUSY').length;
  const recentWorkerErrors = workers.items.filter((worker) => worker.lastError).sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)).slice(0, 5);

  return (
    <section className="page-section">
      <div className="page-heading"><div><p className="eyebrow">Video Factory</p><h1>Resumen</h1><p>Estado real del catálogo y workers persistidos en MariaDB.</p></div><div className="button-row"><Link className="button secondary" to="/workers">Workers</Link><Link className="button secondary" to="/videos">Open video library</Link></div></div>
      {data.legacyIncomplete > 0 ? <div className="warning-banner" role="status"><strong>Legacy incomplete:</strong> {data.legacyIncomplete} video(s) preserve incomplete historical data. No missing scenes are fabricated.</div> : null}
      <div className="metric-grid">
        <article className="metric-card"><span>Total videos</span><strong>{data.totalVideos}</strong></article>
        <article className="metric-card"><span>Workers online</span><strong>{workersOnline}</strong></article>
        <article className="metric-card"><span>Workers busy</span><strong>{workersBusy}</strong></article>
        <article className="metric-card"><span>Queued videos</span><strong>{data.totalsByStatus.QUEUED ?? 0}</strong></article>
        <article className="metric-card"><span>Rendering videos</span><strong>{data.totalsByStatus.RENDERING ?? 0}</strong></article>
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
        <section className="panel"><div className="panel-heading"><h2>Recent worker errors</h2><Link to="/workers">View workers</Link></div>
          {recentWorkerErrors.length === 0 ? <EmptyState title="No worker errors recorded" /> : <div className="stack-list">{recentWorkerErrors.map((worker) => <Link className="stack-row" to="/workers" key={worker.id}><div><strong>{worker.id}</strong><span>{worker.lastError}</span></div><time dateTime={worker.updatedAt}>{new Date(worker.updatedAt).toLocaleString()}</time></Link>)}</div>}
        </section>
      </div>
    </section>
  );
}
