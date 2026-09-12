import { FormEvent, useEffect, useMemo, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { VIDEO_STATUSES, type VideoListDto } from '@contracts';
import { EmptyState, ErrorState, LoadingState } from '../components/States';
import { StatusBadge } from '../components/Status';
import { adminApi } from '../lib/api';

function positiveInt(value: string | null, fallback: number) {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
}

export function VideosPage() {
  const [params, setParams] = useSearchParams();
  const page = positiveInt(params.get('page'), 1);
  const pageSize = Math.min(100, positiveInt(params.get('pageSize'), 25));
  const q = params.get('q') ?? '';
  const status = params.get('status') ?? '';
  const category = params.get('category') ?? '';
  const [draftQ, setDraftQ] = useState(q);
  const [data, setData] = useState<VideoListDto | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<unknown>(null);

  useEffect(() => { setDraftQ(q); }, [q]);
  useEffect(() => {
    let alive = true;
    setLoading(true);
    setError(null);
    const apiParams = new URLSearchParams({ page: String(page), pageSize: String(pageSize) });
    if (q) apiParams.set('search', q);
    if (status) apiParams.set('status', status);
    if (category) apiParams.set('category', category);
    adminApi.videos(apiParams).then((result) => { if (alive) setData(result); }).catch((caught) => { if (alive) setError(caught); }).finally(() => { if (alive) setLoading(false); });
    return () => { alive = false; };
  }, [page, pageSize, q, status, category]);

  const pageCount = useMemo(() => Math.max(1, Math.ceil((data?.total ?? 0) / pageSize)), [data?.total, pageSize]);
  const update = (key: string, value: string) => {
    const next = new URLSearchParams(params);
    if (value) next.set(key, value); else next.delete(key);
    if (key !== 'page') next.set('page', '1');
    setParams(next);
  };
  const submitSearch = (event: FormEvent) => { event.preventDefault(); update('q', draftQ.trim()); };

  return (
    <section className="page-section">
      <div className="page-heading"><div><p className="eyebrow">Library</p><h1>Videos</h1><p>Search, pagination and filters execute server-side.</p></div></div>
      <form className="filter-bar" onSubmit={submitSearch}>
        <label className="search-field"><span>Search</span><input value={draftQ} onChange={(event) => setDraftQ(event.target.value)} placeholder="ID, title, keyword…" /></label>
        <label><span>Status</span><select value={status} onChange={(event) => update('status', event.target.value)}><option value="">All statuses</option>{VIDEO_STATUSES.map((item) => <option value={item} key={item}>{item}</option>)}</select></label>
        <label><span>Category</span><select value={category} onChange={(event) => update('category', event.target.value)}><option value="">All categories</option>{data?.categories.map((item) => <option value={item} key={item}>{item}</option>)}</select></label>
        <label><span>Page size</span><select value={String(pageSize)} onChange={(event) => update('pageSize', event.target.value)}>{[10, 25, 50, 100].map((size) => <option key={size} value={size}>{size}</option>)}</select></label>
        <button className="button primary" type="submit">Search</button>
      </form>
      {error ? <ErrorState error={error} /> : null}
      {loading ? <LoadingState label="Loading videos…" /> : null}
      {!loading && !error && data?.items.length === 0 ? <EmptyState title="No videos match these filters"><button className="button secondary" type="button" onClick={() => setParams({})}>Clear filters</button></EmptyState> : null}
      {!loading && !error && data && data.items.length > 0 ? <>
        <div className="table-wrap">
          <table className="video-table"><thead><tr><th>Video</th><th>Status</th><th>Scenes</th><th>Duration</th><th>Publications</th><th>Created</th></tr></thead><tbody>
            {data.items.map((video) => <tr key={video.id}><td><div className="video-cell"><div className="thumbnail-placeholder" aria-label={video.hasThumbnailReference ? 'Thumbnail reference exists but is not served in Phase 3' : 'No thumbnail'}>{video.hasThumbnailReference ? 'Thumbnail ref' : 'No thumbnail'}</div><div><Link to={`/videos/${encodeURIComponent(video.id)}`}><strong>{video.title}</strong></Link><span>{video.id}</span><span>{video.category}{video.legacyIncomplete ? ' · Legacy incomplete' : ''}</span></div></div></td><td><StatusBadge status={video.status} /></td><td>{video.sceneCount}</td><td>{video.durationSeconds === null ? 'No disponible' : `${video.durationSeconds.toFixed(1)}s`}</td><td><div className="publication-summary">{video.publications.map((publication) => <span key={publication.id}>{publication.platform}: {publication.status}</span>)}</div></td><td><time dateTime={video.createdAt}>{new Date(video.createdAt).toLocaleDateString()}</time></td></tr>)}
          </tbody></table>
        </div>
        <div className="video-card-list">{data.items.map((video) => <article className="video-card" key={video.id}><div className="thumbnail-placeholder">{video.hasThumbnailReference ? 'Thumbnail reference only' : 'No thumbnail'}</div><div className="video-card-heading"><Link to={`/videos/${encodeURIComponent(video.id)}`}><strong>{video.title}</strong></Link><StatusBadge status={video.status} /></div><span>{video.id}</span><span>{video.category} · {video.sceneCount} scenes · {video.durationSeconds === null ? 'duration unavailable' : `${video.durationSeconds.toFixed(1)}s`}</span>{video.legacyIncomplete ? <span className="legacy-flag">Legacy incomplete</span> : null}</article>)}</div>
        <nav className="pagination" aria-label="Video pagination"><button type="button" className="button secondary" disabled={page <= 1} onClick={() => update('page', String(page - 1))}>Previous</button><span>Page {page} of {pageCount} · {data.total} videos</span><button type="button" className="button secondary" disabled={page >= pageCount} onClick={() => update('page', String(page + 1))}>Next</button></nav>
      </> : null}
    </section>
  );
}
