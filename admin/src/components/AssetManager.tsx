import { useCallback, useEffect, useMemo, useState } from 'react';
import type { AssetDto, AssetKindDto, AssetPolicyDto, AssetUploadRequestDto, MultipartCompletedPartDto } from '@contracts';
import { AdminApiError, adminApi } from '../lib/api';
import { EmptyState, ErrorState, LoadingState } from './States';
import { StatusBadge } from './Status';

interface Owner {
  type: 'video' | 'profile';
  id: string;
}

interface AssetManagerProps {
  owner: Owner;
  allowedKinds: AssetKindDto[];
  initialAssets?: AssetDto[];
  onChanged?: () => void | Promise<void>;
}

function formatBytes(raw: string | null): string {
  if (!raw) return 'No disponible';
  const value = Number(raw);
  if (!Number.isFinite(value)) return raw;
  const units = ['B', 'KiB', 'MiB', 'GiB'];
  let amount = value;
  let unit = 0;
  while (amount >= 1024 && unit < units.length - 1) { amount /= 1024; unit += 1; }
  return `${amount.toFixed(unit === 0 ? 0 : 1)} ${units[unit]}`;
}

function acceptedTypes(kind: AssetKindDto, policy: AssetPolicyDto): string[] {
  if (kind === 'VIDEO') return policy.mimeTypes.VIDEO;
  if (kind === 'AUDIO') return policy.mimeTypes.AUDIO;
  return policy.mimeTypes.IMAGE;
}

function maxBytes(kind: AssetKindDto, policy: AssetPolicyDto): bigint {
  if (kind === 'VIDEO') return BigInt(policy.limits.videoBytes);
  if (kind === 'AUDIO') return BigInt(policy.limits.audioBytes);
  return BigInt(policy.limits.imageBytes);
}

function putWithProgress(url: string, body: Blob, headers: Record<string, string>, onProgress: (loaded: number) => void): Promise<string | null> {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open('PUT', url, true);
    for (const [name, value] of Object.entries(headers)) xhr.setRequestHeader(name, value);
    xhr.upload.onprogress = (event) => { if (event.lengthComputable) onProgress(event.loaded); };
    xhr.onerror = () => reject(new Error('Direct R2 upload failed'));
    xhr.onabort = () => reject(new Error('Direct R2 upload was cancelled'));
    xhr.onload = () => {
      if (xhr.status >= 200 && xhr.status < 300) resolve(xhr.getResponseHeader('ETag'));
      else reject(new Error(`Direct R2 upload failed (${xhr.status})`));
    };
    xhr.send(body);
  });
}

export function AssetManager({ owner, allowedKinds, initialAssets, onChanged }: AssetManagerProps) {
  const [policy, setPolicy] = useState<AssetPolicyDto | null>(null);
  const [assets, setAssets] = useState<AssetDto[] | null>(initialAssets ?? null);
  const [kind, setKind] = useState<AssetKindDto>(allowedKinds[0] ?? 'VIDEO');
  const [file, setFile] = useState<File | null>(null);
  const [progress, setProgress] = useState<number | null>(null);
  const [phase, setPhase] = useState<string | null>(null);
  const [error, setError] = useState<unknown>(null);
  const [preview, setPreview] = useState<{ assetId: string; url: string; mimeType: string | null } | null>(null);

  const load = useCallback(async () => {
    setError(null);
    try {
      const nextPolicy = policy ?? await adminApi.assetPolicy();
      if (!policy) setPolicy(nextPolicy);
      if (owner.type === 'video') setAssets((await adminApi.videoAssets(owner.id)).items);
      else if (initialAssets) setAssets(initialAssets);
    } catch (caught) { setError(caught); }
  }, [initialAssets, owner.id, owner.type, policy]);

  useEffect(() => { void load(); }, [load]);
  useEffect(() => { if (initialAssets && owner.type === 'profile') setAssets(initialAssets); }, [initialAssets, owner.type]);

  const current = useMemo(() => (assets ?? []).filter((asset) => asset.status === 'READY'), [assets]);
  const historical = useMemo(() => (assets ?? []).filter((asset) => asset.status !== 'READY'), [assets]);

  const validate = (candidate: File) => {
    if (!policy) throw new Error('Upload policy has not loaded yet');
    if (!acceptedTypes(kind, policy).includes(candidate.type)) throw new Error(`File type ${candidate.type || 'unknown'} is not allowed for ${kind}`);
    if (BigInt(candidate.size) > maxBytes(kind, policy)) throw new Error(`File exceeds the ${kind} application size limit`);
  };

  const createSession = async (body: AssetUploadRequestDto, key: string) => owner.type === 'video'
    ? adminApi.createVideoUpload(owner.id, body, key)
    : adminApi.createProfileUpload(owner.id, body, key);

  const upload = async () => {
    if (!file || !policy) return;
    setError(null);
    setProgress(0);
    setPhase('Creating authorized upload…');
    let sessionId: string | null = null;
    try {
      validate(file);
      const body: AssetUploadRequestDto = { kind, mimeType: file.type, size: String(file.size), originalFilename: file.name };
      const createKey = `admin-asset-${crypto.randomUUID()}`;
      const finalizeKey = `admin-finalize-${crypto.randomUUID()}`;
      let session = await createSession(body, createKey);
      sessionId = session.sessionId;
      const completed: MultipartCompletedPartDto[] = [];
      if (session.mode === 'SINGLE') {
        setPhase('Uploading directly to private R2…');
        let uploaded = false;
        let last: unknown;
        for (let attempt = 1; attempt <= 3 && !uploaded; attempt += 1) {
          try {
            if (!session.uploadUrl) session = await createSession(body, createKey);
            if (!session.uploadUrl) throw new Error('Server did not return a signed upload URL');
            await putWithProgress(session.uploadUrl, file, session.requiredHeaders, (loaded) => setProgress(Math.min(99, Math.round((loaded / file.size) * 100))));
            uploaded = true;
          } catch (caught) {
            last = caught;
            if (attempt < 3) session = await createSession(body, createKey);
          }
        }
        if (!uploaded) throw last ?? new Error('Direct upload failed');
      } else {
        if (!session.partSizeBytes) throw new Error('Multipart part size is unavailable');
        setPhase('Uploading multipart directly to private R2…');
        const partSize = session.partSizeBytes;
        const count = Math.ceil(file.size / partSize);
        let completedBytes = 0;
        for (let partNumber = 1; partNumber <= count; partNumber += 1) {
          const start = (partNumber - 1) * partSize;
          const end = Math.min(file.size, start + partSize);
          const blob = file.slice(start, end);
          let eTag: string | null = null;
          let last: unknown;
          for (let attempt = 1; attempt <= 3 && !eTag; attempt += 1) {
            try {
              const signed = await adminApi.uploadParts(session.sessionId, [partNumber]);
              const part = signed.parts[0];
              if (!part) throw new Error('Part authorization is unavailable');
              eTag = await putWithProgress(part.uploadUrl, blob, {}, (loaded) => setProgress(Math.min(99, Math.round(((completedBytes + loaded) / file.size) * 100))));
            } catch (caught) { last = caught; }
          }
          if (!eTag) throw last ?? new Error(`Multipart part ${partNumber} failed`);
          completed.push({ partNumber, eTag });
          completedBytes += blob.size;
        }
      }
      setPhase('Finalizing and verifying object…');
      setProgress(99);
      await adminApi.finalizeUpload(session.sessionId, completed, finalizeKey);
      setProgress(100);
      setPhase('Ready');
      setFile(null);
      if (owner.type === 'video') setAssets((await adminApi.videoAssets(owner.id)).items);
      await onChanged?.();
    } catch (caught) {
      if (sessionId) { try { await adminApi.abortUpload(sessionId); } catch { /* server expiry/cleanup remains authoritative */ } }
      setError(caught);
      setPhase('Failed');
    }
  };

  const openPreview = async (asset: AssetDto) => {
    setError(null);
    try {
      const signed = await adminApi.downloadAsset(asset.id);
      setPreview({ assetId: asset.id, url: signed.downloadUrl, mimeType: asset.mimeType });
    } catch (caught) { setError(caught); }
  };

  if (!policy || assets === null) return <LoadingState label="Loading durable assets…" />;

  const renderAsset = (asset: AssetDto) => <article className="asset-card" key={asset.id}>
    <div className="data-card-heading"><strong>{asset.kind}</strong><StatusBadge status={asset.status} /></div>
    <dl>
      <div><dt>Storage</dt><dd>{asset.storageProvider}</dd></div>
      <div><dt>MIME</dt><dd>{asset.mimeType ?? 'No disponible'}</dd></div>
      <div><dt>Size</dt><dd>{formatBytes(asset.size)}</dd></div>
      <div><dt>SHA-256</dt><dd className="asset-hash">{asset.sha256 ?? 'No disponible'}</dd></div>
      <div><dt>Hash source</dt><dd>{asset.hashSource ?? 'No disponible'}</dd></div>
      <div><dt>Source</dt><dd>{asset.source ?? (asset.storageProvider === 'LEGACY_LOCAL' ? 'LEGACY' : 'No disponible')}</dd></div>
      <div><dt>Created</dt><dd>{new Date(asset.createdAt).toLocaleString()}</dd></div>
    </dl>
    {(asset.status === 'READY' || asset.status === 'REPLACED') && asset.storageProvider === 'R2' ? <button className="button secondary" type="button" onClick={() => void openPreview(asset)}>Preview / Download</button> : null}
    {preview?.assetId === asset.id ? <div className="asset-preview">{preview.mimeType?.startsWith('video/') ? <video controls src={preview.url} /> : preview.mimeType?.startsWith('image/') ? <img src={preview.url} alt={`${asset.kind} preview`} /> : <a href={preview.url} download>Download temporary file</a>}<button className="button secondary" type="button" onClick={() => setPreview(null)}>Close preview</button></div> : null}
  </article>;

  return <div className="tab-stack">
    <section className="panel asset-upload-panel">
      <div className="section-toolbar"><div><h3>Upload / Replace</h3><p className="muted">The file goes directly to private R2 using short-lived object-specific authorization.</p></div></div>
      <div className="asset-upload-controls">
        <label>Asset kind<select value={kind} onChange={(event) => { setKind(event.target.value as AssetKindDto); setFile(null); }}>{allowedKinds.map((item) => <option value={item} key={item}>{item}</option>)}</select></label>
        <label>File<input type="file" accept={acceptedTypes(kind, policy).join(',')} onChange={(event) => { const next = event.target.files?.[0] ?? null; setError(null); if (next) { try { validate(next); setFile(next); } catch (caught) { setFile(null); setError(caught); } } else setFile(null); }} /></label>
        <button className="button" type="button" disabled={!file || progress !== null && progress < 100 && phase !== 'Failed'} onClick={() => void upload()}>Upload {kind}</button>
      </div>
      {progress !== null ? <div className="upload-progress" aria-live="polite"><div className="section-toolbar"><span>{phase}</span><strong>{progress}%</strong></div><progress max="100" value={progress}>{progress}%</progress></div> : null}
      {error ? <ErrorState error={error instanceof AdminApiError ? error : error} /> : null}
    </section>
    <section className="panel"><h3>Current assets</h3>{current.length ? <div className="asset-grid">{current.map(renderAsset)}</div> : <EmptyState title="No current durable asset in these slots" />}</section>
    {historical.length ? <section className="panel"><h3>Historical / replaced / failed</h3><div className="asset-grid">{historical.map(renderAsset)}</div></section> : null}
  </div>;
}
