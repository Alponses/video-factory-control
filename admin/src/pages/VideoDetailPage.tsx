import { useCallback, useEffect, useMemo, useState } from 'react';
import { Link, useParams, useSearchParams } from 'react-router-dom';
import type { HistoryItemDto, PublicationEditResultDto, SceneEditResultDto, VideoDetailDto, VideoEditResultDto, VideoHistoryDto } from '@contracts';
import { EmptyState, ErrorState, FieldValue, LoadingState } from '../components/States';
import { LifecycleProgress, StatusBadge } from '../components/Status';
import { PublicationCard, SceneCard, VideoEditForm } from '../components/EditForms';
import { adminApi } from '../lib/api';
import { useUnsavedChanges } from '../hooks/useUnsavedChanges';

const tabs = ['summary', 'content', 'scenes', 'assets', 'render', 'publication', 'metrics', 'history'] as const;
type Tab = typeof tabs[number];
const labels: Record<Tab, string> = { summary: 'Resumen', content: 'Contenido', scenes: 'Escenas', assets: 'Assets', render: 'Render / QA', publication: 'Publicación', metrics: 'Métricas', history: 'Historial' };

function formatValue(value: unknown): string {
  if (value === null || value === undefined) return 'No disponible';
  if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') return String(value);
  return JSON.stringify(value);
}

function ChangeTable({ item }: { item: HistoryItemDto }) {
  const keys = [...new Set([...Object.keys(item.before ?? {}), ...Object.keys(item.after ?? {})])];
  if (keys.length === 0) return null;
  return <div className="change-table" role="table" aria-label="Audit changes"><div className="change-row header" role="row"><span>Field</span><span>Before</span><span>After</span></div>{keys.map((key) => <div className="change-row" role="row" key={key}><strong>{key}</strong><span>{formatValue(item.before?.[key])}</span><span>{formatValue(item.after?.[key])}</span></div>)}</div>;
}

function HistoryPanel({ videoId }: { videoId: string }) {
  const [data, setData] = useState<VideoHistoryDto | null>(null);
  const [error, setError] = useState<unknown>(null);
  useEffect(() => { let alive = true; adminApi.history(videoId).then((result) => { if (alive) setData(result); }).catch((caught) => { if (alive) setError(caught); }); return () => { alive = false; }; }, [videoId]);
  if (error) return <ErrorState error={error} />;
  if (!data) return <LoadingState label="Loading history…" />;
  if (data.items.length === 0) return <EmptyState title="No history recorded yet" />;
  return <div className="timeline">{data.items.map((item) => <article className="timeline-item" key={`${item.source}-${item.id}`}><div className="timeline-marker" aria-hidden="true" /><div className="timeline-content"><div className="timeline-heading"><div><strong>{item.summary}</strong><span>{item.actorType} · {item.actor}</span></div><time dateTime={item.timestamp}>{new Date(item.timestamp).toLocaleString()}</time></div><div className="timeline-meta">{item.action} · {item.entityType}{item.entityId ? ` · ${item.entityId}` : ''}</div>{item.before || item.after ? <details><summary>View changes</summary><ChangeTable item={item} /></details> : null}</div></article>)}</div>;
}

function SummaryTab({ data }: { data: VideoDetailDto }) {
  const video = data.video;
  return <div className="tab-stack"><section className="panel"><h2>Video</h2><dl className="detail-grid"><div><dt>ID</dt><dd>{video.id}</dd></div><div><dt>Slug</dt><dd>{video.slug}</dd></div><div><dt>Channel</dt><dd>{data.channel.displayName ?? data.channel.id}</dd></div><div><dt>Category</dt><dd>{video.category}</dd></div><div><dt>Status</dt><dd><StatusBadge status={video.status} /></dd></div><div><dt>Legacy status</dt><dd><FieldValue value={video.legacyStatus} /></dd></div><div><dt>Legacy incomplete</dt><dd>{video.legacyIncomplete ? 'Yes' : 'No'}</dd></div><div><dt>Schema version</dt><dd><FieldValue value={video.schemaVersion} /></dd></div><div><dt>Created</dt><dd>{new Date(video.createdAt).toLocaleString()}</dd></div><div><dt>Updated</dt><dd>{new Date(video.updatedAt).toLocaleString()}</dd></div><div><dt>Version</dt><dd>{video.version}</dd></div><div><dt>Word count</dt><dd><FieldValue value={video.wordCount} /></dd></div></dl></section><section className="panel"><h2>Discovery</h2><dl className="detail-grid"><div><dt>Primary keyword</dt><dd><FieldValue value={video.primaryKeyword} /></dd></div><div className="span-2"><dt>Secondary keywords</dt><dd>{video.secondaryKeywords.length ? <div className="tag-list">{video.secondaryKeywords.map((keyword) => <span className="tag" key={keyword}>{keyword}</span>)}</div> : <span className="muted">No disponible</span>}</dd></div><div className="span-2"><dt>Search intent</dt><dd><FieldValue value={video.searchIntent} /></dd></div></dl></section><section className="panel"><h2>Content</h2><dl className="detail-grid"><div><dt>Hook type</dt><dd><FieldValue value={video.hookType} /></dd></div><div className="span-2"><dt>Hook</dt><dd><FieldValue value={video.hookText} /></dd></div><div className="span-2"><dt>Closing</dt><dd><FieldValue value={video.closing} /></dd></div></dl></section><section className="panel"><h2>Channel profiles</h2>{data.channel.profiles.length ? <div className="profile-grid">{data.channel.profiles.map((profile) => <article className="profile-card" key={profile.id}><strong>{profile.platform}</strong><span>{profile.displayName ?? 'No display name'}</span><span>{profile.username ?? 'No handle'}</span><p>{profile.description ?? 'No description available.'}</p></article>)}</div> : <EmptyState title="No profiles available" />}</section></div>;
}

function AssetsTab({ data }: { data: VideoDetailDto }) {
  if (data.legacyAssets.length === 0) return <div className="tab-stack"><EmptyState title="No legacy assets recorded" /><div className="info-banner">Cloud asset management will be enabled in Phase 5.</div></div>;
  return <div className="tab-stack"><div className="info-banner">Read-only legacy references. Cloud asset management will be enabled in Phase 5.</div><div className="asset-grid">{data.legacyAssets.map((asset) => <article className="asset-card" key={asset.id}><strong>{asset.kind}</strong><span>{asset.storageProvider}</span><dl><div><dt>Status</dt><dd>{asset.status}</dd></div><div><dt>Path</dt><dd>{asset.localPath ?? 'No disponible'}</dd></div><div><dt>MIME</dt><dd>{asset.mimeType ?? 'No disponible'}</dd></div><div><dt>Size</dt><dd>{asset.size ?? 'No disponible'}</dd></div></dl></article>)}</div></div>;
}

function RenderQaTab({ data }: { data: VideoDetailDto }) {
  return <div className="tab-stack"><section className="panel"><div className="section-toolbar"><h2>Render attempts</h2><span className="future-note">Re-render disponible en Fase 4</span></div>{data.renderAttempts.length === 0 ? <EmptyState title="No render attempts recorded" /> : <div className="card-grid">{data.renderAttempts.map((attempt) => <article className="data-card" key={attempt.id}><div className="data-card-heading"><strong>Attempt {attempt.attempt}</strong><StatusBadge status={attempt.status} /></div><dl><div><dt>Worker</dt><dd>{attempt.workerLabel ?? attempt.workerId ?? 'No disponible'}</dd></div><div><dt>Renderer video ID</dt><dd>{attempt.rendererVideoId ?? 'No disponible'}</dd></div><div><dt>Started</dt><dd>{attempt.startedAt ? new Date(attempt.startedAt).toLocaleString() : 'No disponible'}</dd></div><div><dt>Finished</dt><dd>{attempt.finishedAt ? new Date(attempt.finishedAt).toLocaleString() : 'No disponible'}</dd></div><div><dt>Duration</dt><dd>{attempt.durationSeconds === null ? 'No disponible' : `${attempt.durationSeconds}s`}</dd></div><div><dt>Resolution</dt><dd>{attempt.width && attempt.height ? `${attempt.width}×${attempt.height}` : 'No disponible'}</dd></div><div><dt>Audio</dt><dd>{attempt.hasAudio === null ? 'No disponible' : attempt.hasAudio ? 'Yes' : 'No'}</dd></div><div><dt>Error</dt><dd>{attempt.error ?? 'None'}</dd></div></dl></article>)}</div>}</section><section className="panel"><h2>QA</h2>{data.qa.length === 0 ? <EmptyState title="No QA results recorded" /> : <div className="card-grid">{data.qa.map((qa) => <article className="data-card" key={qa.id}><div className="data-card-heading"><strong>Attempt {qa.attempt}</strong><span>{qa.passed === null ? 'Not evaluated' : qa.passed ? '✓ Passed' : '✕ Failed'}</span></div><dl><div><dt>Duration</dt><dd>{qa.durationPassed === null ? 'No disponible' : qa.durationPassed ? '✓' : '✕'}</dd></div><div><dt>Resolution</dt><dd>{qa.resolutionPassed === null ? 'No disponible' : qa.resolutionPassed ? '✓' : '✕'}</dd></div><div><dt>Audio</dt><dd>{qa.audioPassed === null ? 'No disponible' : qa.audioPassed ? '✓' : '✕'}</dd></div><div><dt>Captions</dt><dd>{qa.captionsPassed === null ? 'No disponible' : qa.captionsPassed ? '✓' : '✕'}</dd></div></dl></article>)}</div>}</section></div>;
}

function MetricsTab({ data }: { data: VideoDetailDto }) {
  const hasMetrics = data.publications.some((publication) => publication.metrics.length > 0 || publication.snapshots.length > 0);
  if (!hasMetrics) return <EmptyState title="No metrics collected yet." />;
  return <div className="tab-stack">{data.publications.map((publication) => <section className="panel" key={publication.id}><h2>{publication.platform}</h2>{publication.metrics.length ? <div className="metric-list">{publication.metrics.map((metric) => <div className="metric-row" key={metric.key}><strong>{metric.key}</strong><span>{metric.availability}</span><span>{metric.numericValue ?? 'No disponible'}</span></div>)}</div> : null}{publication.snapshots.length ? <div className="snapshot-list">{publication.snapshots.map((snapshot) => <article className="snapshot-card" key={snapshot.id}><time dateTime={snapshot.capturedAt}>{new Date(snapshot.capturedAt).toLocaleString()}</time><span>Views: {snapshot.views ?? 'No disponible'}</span><span>Likes: {snapshot.likes ?? 'No disponible'}</span><span>Comments: {snapshot.comments ?? 'No disponible'}</span><span>Shares: {snapshot.shares ?? 'No disponible'}</span><span>Revenue: {snapshot.revenue ?? 'No disponible'}</span></article>)}</div> : null}</section>)}</div>;
}

export function VideoDetailPage() {
  const { videoId = '' } = useParams();
  const [params, setParams] = useSearchParams();
  const requestedTab = params.get('tab');
  const tab: Tab = tabs.includes(requestedTab as Tab) ? requestedTab as Tab : 'summary';
  const [data, setData] = useState<VideoDetailDto | null>(null);
  const [error, setError] = useState<unknown>(null);
  const [loading, setLoading] = useState(true);
  const [dirtyKeys, setDirtyKeys] = useState<Set<string>>(new Set());
  useUnsavedChanges(dirtyKeys.size > 0);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try { setData(await adminApi.video(videoId)); } catch (caught) { setError(caught); } finally { setLoading(false); }
  }, [videoId]);
  useEffect(() => { void load(); }, [load]);
  const onDirtyChange = useCallback((key: string, dirty: boolean) => setDirtyKeys((current) => { const next = new Set(current); if (dirty) next.add(key); else next.delete(key); return next; }), []);
  const onVideoSaved = (result: VideoEditResultDto) => setData((current) => current ? { ...current, video: { ...current.video, ...result } } : current);
  const onSceneSaved = (result: SceneEditResultDto) => setData((current) => current ? { ...current, scenes: current.scenes.map((scene) => scene.position === result.position ? result : scene) } : current);
  const onPublicationSaved = (result: PublicationEditResultDto) => setData((current) => current ? { ...current, publications: current.publications.map((publication) => publication.id === result.id ? { ...publication, ...result } : publication) } : current);
  const setTab = (next: Tab) => { const nextParams = new URLSearchParams(params); if (next === 'summary') nextParams.delete('tab'); else nextParams.set('tab', next); setParams(nextParams); };

  if (error) return <section className="page-section"><Link className="back-link" to="/videos">← Videos</Link><ErrorState error={error} action={<button className="button secondary" type="button" onClick={() => void load()}>Retry</button>} /></section>;
  if (loading || !data) return <LoadingState label="Loading video…" />;
  const video = data.video;
  return <section className="page-section video-detail-page"><Link className="back-link" to="/videos">← Videos</Link><header className="video-detail-header"><div><div className="header-meta"><span>{video.id}</span><span>{video.category}</span><span>Version {video.version}</span></div><h1>{video.title}</h1><div className="header-status"><StatusBadge status={video.status} />{video.legacyIncomplete ? <span className="legacy-flag">Legacy incomplete</span> : null}</div></div><div className="header-date"><span>Created</span><time dateTime={video.createdAt}>{new Date(video.createdAt).toLocaleString()}</time></div></header><LifecycleProgress status={video.status} />
    <div className="tabs" role="tablist" aria-label="Video detail sections">{tabs.map((item) => <button role="tab" aria-selected={tab === item} className={tab === item ? 'tab active' : 'tab'} type="button" key={item} onClick={() => setTab(item)}>{labels[item]}{item === 'scenes' ? ` (${data.scenes.length})` : ''}</button>)}</div>
    <div className="tab-content" role="tabpanel">
      {tab === 'summary' ? <SummaryTab data={data} /> : null}
      {tab === 'content' ? <VideoEditForm video={video} onSaved={onVideoSaved} onReload={load} onDirtyChange={onDirtyChange} /> : null}
      {tab === 'scenes' ? (data.scenes.length === 0 ? <div className="warning-banner"><strong>Legacy incomplete</strong><p>No historical scenes exist. Video Factory does not fabricate missing scene data.</p></div> : <div className="scene-list">{data.scenes.map((scene) => <SceneCard videoId={video.id} scene={scene} onSaved={onSceneSaved} onReload={load} onDirtyChange={onDirtyChange} key={scene.id} />)}</div>) : null}
      {tab === 'assets' ? <AssetsTab data={data} /> : null}
      {tab === 'render' ? <RenderQaTab data={data} /> : null}
      {tab === 'publication' ? <div className="publication-list">{data.publications.length ? data.publications.map((publication) => <PublicationCard publication={publication} onSaved={onPublicationSaved} onReload={load} onDirtyChange={onDirtyChange} key={publication.id} />) : <EmptyState title="No publication metadata available" />}</div> : null}
      {tab === 'metrics' ? <MetricsTab data={data} /> : null}
      {tab === 'history' ? <HistoryPanel videoId={video.id} /> : null}
    </div>
  </section>;
}
