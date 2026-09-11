import { FormEvent, useCallback, useEffect, useState } from 'react';
import { EmptyState, ErrorState, LoadingState } from '../components/States';
import { adminApi } from '../lib/api';
import type { WorkerListView, WorkerView } from '../types/worker';

function RelativeHeartbeat({ value }: { value: string | null }) {
  if (!value) return <span className="muted">Never</span>;
  const ageSeconds = Math.max(0, Math.floor((Date.now() - new Date(value).getTime()) / 1000));
  const relative = ageSeconds < 60 ? `${ageSeconds}s ago` : ageSeconds < 3600 ? `${Math.floor(ageSeconds / 60)}m ago` : `${Math.floor(ageSeconds / 3600)}h ago`;
  return <time dateTime={value} title={new Date(value).toLocaleString()}>{relative}</time>;
}

function WorkerStatus({ worker }: { worker: WorkerView }) {
  return <span className={`status-badge status-${worker.effectiveStatus.toLowerCase()}`}>{worker.effectiveStatus}</span>;
}

function OneTimeSecret({ secret, onClose }: { secret: string; onClose: () => void }) {
  const [copied, setCopied] = useState(false);
  const copy = async () => {
    await navigator.clipboard.writeText(secret);
    setCopied(true);
  };
  return <div className="warning-banner one-time-secret" role="status">
    <strong>Copy this secret now. It will not be shown again.</strong>
    <code>{secret}</code>
    <div className="button-row"><button className="button" type="button" onClick={() => void copy()}>{copied ? 'Copied' : 'Copy secret'}</button><button className="button secondary" type="button" onClick={onClose}>Close</button></div>
  </div>;
}

export function WorkersPage() {
  const [data, setData] = useState<WorkerListView | null>(null);
  const [error, setError] = useState<unknown>(null);
  const [workerId, setWorkerId] = useState('');
  const [secret, setSecret] = useState<string | null>(null);
  const [busyAction, setBusyAction] = useState<string | null>(null);

  const load = useCallback(async () => {
    setError(null);
    try { setData(await adminApi.workers()); } catch (caught) { setError(caught); }
  }, []);
  useEffect(() => { void load(); }, [load]);

  const create = async (event: FormEvent) => {
    event.preventDefault();
    if (!workerId.trim()) return;
    setBusyAction('create'); setError(null); setSecret(null);
    try {
      const result = await adminApi.createWorker(workerId.trim());
      setSecret(result.secret);
      setWorkerId('');
      await load();
    } catch (caught) { setError(caught); } finally { setBusyAction(null); }
  };

  const act = async (worker: WorkerView, action: 'rotate' | 'revoke' | 'enable') => {
    const prompt = action === 'rotate' ? `Rotate the secret for ${worker.id}? The old secret will stop working immediately.` : action === 'revoke' ? `Revoke ${worker.id}? It will stop authenticating immediately.` : `Enable ${worker.id} with its current secret?`;
    if (!window.confirm(prompt)) return;
    setBusyAction(`${action}:${worker.id}`); setError(null); setSecret(null);
    try {
      if (action === 'rotate') {
        const result = await adminApi.rotateWorkerSecret(worker.id);
        setSecret(result.secret);
      } else if (action === 'revoke') await adminApi.revokeWorker(worker.id);
      else await adminApi.enableWorker(worker.id);
      await load();
    } catch (caught) { setError(caught); } finally { setBusyAction(null); }
  };

  if (!data && !error) return <LoadingState label="Loading workers…" />;
  return <section className="page-section">
    <div className="page-heading"><div><p className="eyebrow">Distributed factory</p><h1>Workers</h1><p>Real agent state from MariaDB. Offline threshold: {data?.offlineThresholdSeconds ?? '—'}s.</p></div></div>
    {error ? <ErrorState error={error} action={<button type="button" className="button secondary" onClick={() => void load()}>Retry</button>} /> : null}
    {secret ? <OneTimeSecret secret={secret} onClose={() => setSecret(null)} /> : null}
    <section className="panel">
      <h2>Create worker</h2>
      <form className="inline-form" onSubmit={(event) => void create(event)}>
        <label><span>Worker ID</span><input value={workerId} onChange={(event) => setWorkerId(event.target.value)} placeholder="imac-01" pattern="[a-z0-9]+(?:-[a-z0-9]+)*" maxLength={64} required /></label>
        <button className="button" type="submit" disabled={busyAction === 'create'}>{busyAction === 'create' ? 'Creating…' : 'Create worker'}</button>
      </form>
    </section>
    <section className="panel">
      <div className="panel-heading"><h2>Registered workers</h2><button className="button secondary" type="button" onClick={() => void load()}>Refresh</button></div>
      {data && data.items.length === 0 ? <EmptyState title="No workers registered" /> : <div className="table-wrap"><table className="data-table"><thead><tr><th>Worker</th><th>Status</th><th>Versions</th><th>Heartbeat</th><th>Current video</th><th>Progress</th><th>Last error</th><th>Updated</th><th>Actions</th></tr></thead><tbody>{data?.items.map((worker) => <tr key={worker.id}><td><strong>{worker.id}</strong><small>secret v{worker.secretVersion}</small></td><td><WorkerStatus worker={worker} /></td><td><span>Agent {worker.agentVersion ?? '—'}</span><small>Renderer {worker.rendererVersion ?? '—'}</small></td><td><RelativeHeartbeat value={worker.lastHeartbeatAt} /></td><td>{worker.currentVideoId ?? '—'}</td><td>{worker.progress === null ? '—' : `${worker.progress}%`}</td><td>{worker.lastError ?? '—'}</td><td><time dateTime={worker.updatedAt}>{new Date(worker.updatedAt).toLocaleString()}</time></td><td><div className="action-cluster"><button type="button" className="button secondary" disabled={Boolean(busyAction)} onClick={() => void act(worker, 'rotate')}>Rotate secret</button>{worker.effectiveStatus === 'DISABLED' ? <button type="button" className="button secondary" disabled={Boolean(busyAction)} onClick={() => void act(worker, 'enable')}>Enable</button> : <button type="button" className="button danger" disabled={Boolean(busyAction)} onClick={() => void act(worker, 'revoke')}>Revoke</button>}</div></td></tr>)}</tbody></table></div>}
    </section>
  </section>;
}
