import { FormEvent, useEffect, useMemo, useState } from 'react';
import type {
  PublicationDto,
  PublicationEditResultDto,
  SceneDto,
  SceneEditResultDto,
  VideoDto,
  VideoEditResultDto,
} from '@contracts';
import { AdminApiError, adminApi } from '../lib/api';
import { StatusBadge } from './Status';

function nullable(value: string): string | null { return value.trim() ? value.trim() : null; }

function useDirtyRegistration(key: string, dirty: boolean, onDirtyChange: (key: string, dirty: boolean) => void) {
  useEffect(() => {
    onDirtyChange(key, dirty);
    return () => onDirtyChange(key, false);
  }, [key, dirty, onDirtyChange]);
}

function ConflictNotice({ message, copyData, onReload, onCancel }: { message: string; copyData: unknown; onReload: () => void | Promise<void>; onCancel: () => void }) {
  const [copyState, setCopyState] = useState<'idle' | 'copied' | 'fallback'>('idle');
  const serialized = useMemo(() => JSON.stringify(copyData, null, 2), [copyData]);
  const copy = async () => {
    try {
      if (!navigator.clipboard?.writeText) throw new Error('Clipboard unavailable');
      await navigator.clipboard.writeText(serialized);
      setCopyState('copied');
    } catch {
      setCopyState('fallback');
    }
  };
  return <div className="conflict-panel" role="alert"><strong>{message}</strong><p>Newer data will never be overwritten automatically.</p><div className="button-row"><button className="button primary" type="button" onClick={() => void onReload()}>Reload latest version</button><button className="button secondary" type="button" onClick={onCancel}>Cancel</button><button className="button secondary" type="button" onClick={() => void copy()}>Copy my unsaved changes</button></div>{copyState === 'copied' ? <span className="success-text">Copied.</span> : null}{copyState === 'fallback' ? <label className="fallback-copy"><span>Clipboard unavailable. Select and copy:</span><textarea readOnly value={serialized} /></label> : null}</div>;
}

type VideoForm = {
  title: string; category: string; primaryKeyword: string; searchIntent: string; hookText: string; hookType: string; closing: string; cta: string; question: string; pinnedComment: string;
};
function videoForm(video: VideoDto): VideoForm {
  return { title: video.title, category: video.category, primaryKeyword: video.primaryKeyword ?? '', searchIntent: video.searchIntent ?? '', hookText: video.hookText ?? '', hookType: video.hookType ?? '', closing: video.closing ?? '', cta: video.cta ?? '', question: video.question ?? '', pinnedComment: video.pinnedComment ?? '' };
}

export function VideoEditForm({ video, onSaved, onReload, onDirtyChange }: { video: VideoDto; onSaved: (result: VideoEditResultDto) => void; onReload: () => Promise<void>; onDirtyChange: (key: string, dirty: boolean) => void }) {
  const [editing, setEditing] = useState(false);
  const [form, setForm] = useState<VideoForm>(() => videoForm(video));
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [conflict, setConflict] = useState(false);
  const dirty = editing && JSON.stringify(form) !== JSON.stringify(videoForm(video));
  useDirtyRegistration('video', dirty, onDirtyChange);
  useEffect(() => { if (!editing) setForm(videoForm(video)); }, [video, editing]);
  const setField = (field: keyof VideoForm, value: string) => setForm((current) => ({ ...current, [field]: value }));
  const cancel = () => { setEditing(false); setForm(videoForm(video)); setError(null); setConflict(false); };
  const submit = async (event: FormEvent) => {
    event.preventDefault();
    setError(null);
    setConflict(false);
    if (!form.title.trim() || !form.category.trim()) { setError('Title and category are required.'); return; }
    setSaving(true);
    try {
      const result = await adminApi.updateVideo(video.id, {
        expectedVersion: video.version,
        title: form.title.trim(),
        category: form.category.trim(),
        primaryKeyword: nullable(form.primaryKeyword),
        searchIntent: nullable(form.searchIntent),
        hookText: nullable(form.hookText),
        hookType: nullable(form.hookType),
        closing: nullable(form.closing),
        cta: nullable(form.cta),
        question: nullable(form.question),
        pinnedComment: nullable(form.pinnedComment),
      });
      onSaved(result);
      setEditing(false);
    } catch (caught) {
      if (caught instanceof AdminApiError && caught.status === 409 && caught.code === 'VIDEO_VERSION_CONFLICT') setConflict(true);
      else setError(caught instanceof AdminApiError ? caught.message : 'Unable to save video.');
    } finally { setSaving(false); }
  };
  if (!editing) return <div className="edit-section"><div className="section-toolbar"><h3>Editable metadata</h3><button className="button secondary" type="button" onClick={() => setEditing(true)}>Edit</button></div><dl className="detail-grid"><div><dt>Title</dt><dd>{video.title}</dd></div><div><dt>Category</dt><dd>{video.category}</dd></div><div><dt>Primary keyword</dt><dd>{video.primaryKeyword ?? 'No disponible'}</dd></div><div><dt>Hook type</dt><dd>{video.hookType ?? 'No disponible'}</dd></div><div className="span-2"><dt>Search intent</dt><dd>{video.searchIntent ?? 'No disponible'}</dd></div><div className="span-2"><dt>Hook</dt><dd>{video.hookText ?? 'No disponible'}</dd></div><div className="span-2"><dt>Closing</dt><dd>{video.closing ?? 'No disponible'}</dd></div><div className="span-2"><dt>CTA</dt><dd>{video.cta ?? 'No disponible'}</dd></div><div className="span-2"><dt>Question</dt><dd>{video.question ?? 'No disponible'}</dd></div><div className="span-2"><dt>Pinned comment</dt><dd>{video.pinnedComment ?? 'No disponible'}</dd></div></dl></div>;
  return <form className="edit-form" onSubmit={submit}><div className="section-toolbar"><h3>Edit video metadata</h3><span>Version {video.version}</span></div>{error ? <div className="inline-error" role="alert">{error}</div> : null}{conflict ? <ConflictNotice message="Este video cambió desde que lo abriste." copyData={form} onCancel={() => setConflict(false)} onReload={async () => { await onReload(); setEditing(false); setConflict(false); }} /> : null}<div className="form-grid"><label><span>Title</span><input required maxLength={500} value={form.title} onChange={(event) => setField('title', event.target.value)} /></label><label><span>Category</span><input required maxLength={191} value={form.category} onChange={(event) => setField('category', event.target.value)} /></label><label><span>Primary keyword</span><input maxLength={500} value={form.primaryKeyword} onChange={(event) => setField('primaryKeyword', event.target.value)} /></label><label><span>Hook type</span><input maxLength={64} value={form.hookType} onChange={(event) => setField('hookType', event.target.value)} /></label><label className="span-2"><span>Search intent</span><textarea value={form.searchIntent} onChange={(event) => setField('searchIntent', event.target.value)} /></label><label className="span-2"><span>Hook</span><textarea value={form.hookText} onChange={(event) => setField('hookText', event.target.value)} /></label><label className="span-2"><span>Closing</span><textarea value={form.closing} onChange={(event) => setField('closing', event.target.value)} /></label><label className="span-2"><span>CTA</span><textarea value={form.cta} onChange={(event) => setField('cta', event.target.value)} /></label><label className="span-2"><span>Question</span><textarea value={form.question} onChange={(event) => setField('question', event.target.value)} /></label><label className="span-2"><span>Pinned comment</span><textarea value={form.pinnedComment} onChange={(event) => setField('pinnedComment', event.target.value)} /></label></div><div className="button-row"><button className="button primary" type="submit" disabled={saving || !dirty}>{saving ? 'Saving…' : 'Save'}</button><button className="button secondary" type="button" disabled={saving} onClick={cancel}>Cancel</button></div></form>;
}

export function SceneCard({ videoId, scene, onSaved, onReload, onDirtyChange }: { videoId: string; scene: SceneDto; onSaved: (result: SceneEditResultDto) => void; onReload: () => Promise<void>; onDirtyChange: (key: string, dirty: boolean) => void }) {
  const [editing, setEditing] = useState(false);
  const [text, setText] = useState(scene.text);
  const [terms, setTerms] = useState(scene.searchTerms);
  const [termInput, setTermInput] = useState('');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [conflict, setConflict] = useState(false);
  const dirty = editing && (text !== scene.text || JSON.stringify(terms) !== JSON.stringify(scene.searchTerms));
  useDirtyRegistration(`scene-${scene.position}`, dirty, onDirtyChange);
  useEffect(() => { if (!editing) { setText(scene.text); setTerms(scene.searchTerms); } }, [scene, editing]);
  const addTerm = () => { const value = termInput.trim(); if (!value || terms.includes(value) || terms.length >= 30) return; setTerms((current) => [...current, value]); setTermInput(''); };
  const move = (index: number, direction: -1 | 1) => { const next = index + direction; if (next < 0 || next >= terms.length) return; setTerms((current) => { const clone = [...current]; const item = clone[index]; if (item === undefined) return current; clone.splice(index, 1); clone.splice(next, 0, item); return clone; }); };
  const submit = async (event: FormEvent) => { event.preventDefault(); setError(null); setConflict(false); if (!text.trim()) { setError('Scene text is required.'); return; } setSaving(true); try { const result = await adminApi.updateScene(videoId, scene.position, { expectedVersion: scene.version, text, searchTerms: terms }); onSaved(result); setEditing(false); } catch (caught) { if (caught instanceof AdminApiError && caught.status === 409 && caught.code === 'SCENE_VERSION_CONFLICT') setConflict(true); else setError(caught instanceof AdminApiError ? caught.message : 'Unable to save scene.'); } finally { setSaving(false); } };
  return <article className="scene-card"><div className="scene-heading"><div><span className="scene-position">Scene {scene.position}</span><span>Version {scene.version}</span></div>{!editing ? <button className="button secondary small" type="button" onClick={() => setEditing(true)}>Edit</button> : null}</div>{editing ? <form onSubmit={submit}>{error ? <div className="inline-error" role="alert">{error}</div> : null}{conflict ? <ConflictNotice message="Esta escena cambió desde que la abriste." copyData={{ text, searchTerms: terms }} onCancel={() => setConflict(false)} onReload={async () => { await onReload(); setEditing(false); setConflict(false); }} /> : null}<label><span>Text</span><textarea className="scene-textarea" value={text} onChange={(event) => setText(event.target.value)} /></label><div className="tag-editor"><span className="field-label">Search terms</span><div className="tag-list">{terms.map((term, index) => <span className="tag editable" key={`${term}-${index}`}>{term}<button type="button" aria-label={`Move ${term} left`} disabled={index === 0} onClick={() => move(index, -1)}>←</button><button type="button" aria-label={`Move ${term} right`} disabled={index === terms.length - 1} onClick={() => move(index, 1)}>→</button><button type="button" aria-label={`Remove ${term}`} onClick={() => setTerms((current) => current.filter((_, itemIndex) => itemIndex !== index))}>×</button></span>)}</div><div className="tag-add"><input maxLength={200} value={termInput} onChange={(event) => setTermInput(event.target.value)} placeholder="Add search term" /><button className="button secondary small" type="button" onClick={addTerm}>Add</button></div></div><div className="button-row"><button className="button primary" type="submit" disabled={saving || !dirty}>{saving ? 'Saving…' : 'Save'}</button><button className="button secondary" type="button" disabled={saving} onClick={() => { setEditing(false); setText(scene.text); setTerms(scene.searchTerms); setConflict(false); setError(null); }}>Cancel</button></div></form> : <><p className="scene-copy">{scene.text}</p><div className="tag-list">{scene.searchTerms.map((term, index) => <span className="tag" key={`${term}-${index}`}>{term}</span>)}</div></>}</article>;
}

export function PublicationCard({ publication, onSaved, onReload, onDirtyChange }: { publication: PublicationDto; onSaved: (result: PublicationEditResultDto) => void; onReload: () => Promise<void>; onDirtyChange: (key: string, dirty: boolean) => void }) {
  const original = useMemo(() => ({ title: publication.title ?? '', caption: publication.caption ?? '', description: publication.description ?? '', hashtags: publication.hashtags, cta: publication.cta ?? '', pinnedComment: publication.pinnedComment ?? '' }), [publication]);
  const [editing, setEditing] = useState(false);
  const [form, setForm] = useState(original);
  const [tagInput, setTagInput] = useState('');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [conflict, setConflict] = useState(false);
  const dirty = editing && JSON.stringify(form) !== JSON.stringify(original);
  useDirtyRegistration(`publication-${publication.id}`, dirty, onDirtyChange);
  useEffect(() => { if (!editing) setForm(original); }, [original, editing]);
  const addTag = () => { const value = tagInput.trim(); if (!value || form.hashtags.includes(value) || form.hashtags.length >= 30) return; setForm((current) => ({ ...current, hashtags: [...current.hashtags, value] })); setTagInput(''); };
  const submit = async (event: FormEvent) => { event.preventDefault(); setError(null); setConflict(false); setSaving(true); try { const result = await adminApi.updatePublication(publication.id, { expectedVersion: publication.version, title: nullable(form.title), caption: nullable(form.caption), description: nullable(form.description), hashtags: form.hashtags, cta: nullable(form.cta), pinnedComment: nullable(form.pinnedComment) }); onSaved(result); setEditing(false); } catch (caught) { if (caught instanceof AdminApiError && caught.status === 409 && caught.code === 'PUBLICATION_VERSION_CONFLICT') setConflict(true); else setError(caught instanceof AdminApiError ? caught.message : 'Unable to save publication metadata.'); } finally { setSaving(false); } };
  return <article className="publication-card"><div className="publication-heading"><div><h3>{publication.platform}</h3><StatusBadge status={publication.status} /></div><div><span>Version {publication.version}</span>{!editing ? <button className="button secondary small" type="button" onClick={() => setEditing(true)}>Edit metadata</button> : null}</div></div>{editing ? <form className="edit-form compact" onSubmit={submit}>{error ? <div className="inline-error" role="alert">{error}</div> : null}{conflict ? <ConflictNotice message="Esta publicación cambió desde que la abriste." copyData={form} onCancel={() => setConflict(false)} onReload={async () => { await onReload(); setEditing(false); setConflict(false); }} /> : null}<label><span>Title</span><input maxLength={500} value={form.title} onChange={(event) => setForm((current) => ({ ...current, title: event.target.value }))} /></label><label><span>Caption</span><textarea value={form.caption} onChange={(event) => setForm((current) => ({ ...current, caption: event.target.value }))} /></label><label><span>Description</span><textarea value={form.description} onChange={(event) => setForm((current) => ({ ...current, description: event.target.value }))} /></label><div className="tag-editor"><span className="field-label">Hashtags</span><div className="tag-list">{form.hashtags.map((tag, index) => <span className="tag editable" key={`${tag}-${index}`}>{tag}<button type="button" aria-label={`Remove ${tag}`} onClick={() => setForm((current) => ({ ...current, hashtags: current.hashtags.filter((_, itemIndex) => itemIndex !== index) }))}>×</button></span>)}</div><div className="tag-add"><input value={tagInput} onChange={(event) => setTagInput(event.target.value)} placeholder="#hashtag" /><button className="button secondary small" type="button" onClick={addTag}>Add</button></div></div><label><span>CTA</span><textarea value={form.cta} onChange={(event) => setForm((current) => ({ ...current, cta: event.target.value }))} /></label><label><span>Pinned comment</span><textarea value={form.pinnedComment} onChange={(event) => setForm((current) => ({ ...current, pinnedComment: event.target.value }))} /></label><div className="button-row"><button className="button primary" type="submit" disabled={saving || !dirty}>{saving ? 'Saving…' : 'Save'}</button><button className="button secondary" type="button" onClick={() => { setEditing(false); setForm(original); setConflict(false); setError(null); }}>Cancel</button></div></form> : <dl className="detail-grid"><div className="span-2"><dt>Title</dt><dd>{publication.title ?? 'No disponible'}</dd></div><div className="span-2"><dt>Caption</dt><dd>{publication.caption ?? 'No disponible'}</dd></div><div className="span-2"><dt>Description</dt><dd>{publication.description ?? 'No disponible'}</dd></div><div className="span-2"><dt>Hashtags</dt><dd><div className="tag-list">{publication.hashtags.length ? publication.hashtags.map((tag) => <span className="tag" key={tag}>{tag}</span>) : 'No disponible'}</div></dd></div><div className="span-2"><dt>CTA</dt><dd>{publication.cta ?? 'No disponible'}</dd></div><div className="span-2"><dt>Pinned comment</dt><dd>{publication.pinnedComment ?? 'No disponible'}</dd></div><div><dt>Platform ID</dt><dd>{publication.platformId ?? 'No disponible'}</dd></div><div><dt>Published</dt><dd>{publication.publishedAt ? new Date(publication.publishedAt).toLocaleString() : 'No disponible'}</dd></div><div className="span-2"><dt>URL</dt><dd>{publication.url ? <a href={publication.url} target="_blank" rel="noreferrer">Open published URL</a> : 'No disponible'}</dd></div></dl>}</article>;
}
