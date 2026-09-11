import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { createMemoryRouter, RouterProvider } from 'react-router-dom';
import { describe, expect, it, vi } from 'vitest';
import { AssetManager } from '../components/AssetManager';
import { ChannelsPage } from '../pages/ChannelsPage';

const policy = {
  presignTtlSeconds: 300,
  singleUploadThresholdBytes: '104857600',
  multipartPartSizeBytes: 16777216,
  limits: { videoBytes: String(2 * 1024 * 1024 * 1024), imageBytes: String(20 * 1024 * 1024), audioBytes: String(200 * 1024 * 1024) },
  mimeTypes: { VIDEO: ['video/mp4'], IMAGE: ['image/jpeg', 'image/png', 'image/webp'], AUDIO: ['audio/mpeg', 'audio/wav', 'audio/x-wav'] },
};

function json(body: unknown, status = 200) { return Promise.resolve(new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })); }

class FakeXHR {
  static sends = 0;
  static statusCode = 200;
  status = FakeXHR.statusCode;
  upload: { onprogress: ((event: ProgressEvent) => void) | null } = { onprogress: null };
  onerror: (() => void) | null = null;
  onabort: (() => void) | null = null;
  onload: (() => void) | null = null;
  open(_method: string, _url: string, _async: boolean) {}
  setRequestHeader(_name: string, _value: string) {}
  getResponseHeader(name: string) { return name.toLowerCase() === 'etag' ? '"ui-etag"' : null; }
  send(body: Blob) {
    FakeXHR.sends += 1;
    this.status = FakeXHR.statusCode;
    queueMicrotask(() => {
      this.upload.onprogress?.({ lengthComputable: true, loaded: body.size } as ProgressEvent);
      this.onload?.();
    });
  }
}

function setupGlobals() {
  FakeXHR.sends = 0; FakeXHR.statusCode = 200;
  vi.stubGlobal('XMLHttpRequest', FakeXHR);
  vi.stubGlobal('crypto', { randomUUID: vi.fn(() => `uuid-${Math.random()}`) });
}

function readyAsset(kind: 'VIDEO' | 'COVER' | 'THUMBNAIL', mimeType: string) {
  return { id: `asset-${kind}`, videoId: 'video-1', profileId: null, kind, status: 'READY', platform: null, storageProvider: 'R2', mimeType, size: '1024', sha256: null, source: 'ADMIN', hashSource: 'UNKNOWN', originalFilename: `${kind}.bin`, createdAt: '2026-09-11T12:00:00.000Z', updatedAt: '2026-09-11T12:00:00.000Z' };
}

function renderAssetManager() {
  render(<AssetManager owner={{ type: 'video', id: 'video-1' }} allowedKinds={['VIDEO', 'COVER', 'THUMBNAIL']} />);
}

describe('Phase 5 Admin durable assets', () => {
  it.each([
    ['VIDEO', 'video/mp4'], ['COVER', 'image/webp'], ['THUMBNAIL', 'image/png'],
  ] as const)('uploads %s directly with XHR while control-plane calls remain fetch', async (kind, mimeType) => {
    setupGlobals();
    let assets: unknown[] = [];
    const fetchMock = vi.fn((input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      if (url === '/api/admin/assets/policy') return json(policy);
      if (url === '/api/admin/videos/video-1/assets' && (!init?.method || init.method === 'GET')) return json({ items: assets });
      if (url.endsWith('/assets/uploads') && init?.method === 'POST') return json({ sessionId: 'session-1', assetId: `asset-${kind}`, mode: 'SINGLE', status: 'UPLOADING', uploadUrl: 'https://edge.r2.cloudflarestorage.com/object?X-Amz-Signature=temporary', requiredHeaders: { 'Content-Type': mimeType }, expiresAt: '2026-09-11T23:00:00.000Z', sessionExpiresAt: '2026-09-12T00:00:00.000Z', partSizeBytes: null }, 201);
      if (url.includes('/complete') && init?.method === 'POST') { const asset = readyAsset(kind, mimeType); assets = [asset]; return json(asset); }
      if (url.includes('/abort') && init?.method === 'POST') return json({ sessionId: 'session-1', status: 'ABORTED' });
      return json({ error: { code: 'UNEXPECTED', message: url } }, 500);
    });
    vi.stubGlobal('fetch', fetchMock);
    renderAssetManager();
    await screen.findByText('No current durable asset in these slots');
    fireEvent.change(screen.getByLabelText('Asset kind'), { target: { value: kind } });
    const file = new File([new Uint8Array(1024)], `${kind.toLowerCase()}.bin`, { type: mimeType });
    fireEvent.change(screen.getByLabelText('File'), { target: { files: [file] } });
    fireEvent.click(screen.getByRole('button', { name: `Upload ${kind}` }));
    expect(await screen.findByText('100%')).toBeInTheDocument();
    expect(screen.getByText('Ready')).toBeInTheDocument();
    expect(FakeXHR.sends).toBe(1);
    expect(fetchMock.mock.calls.every((call) => String(call[0]).startsWith('/api/admin/'))).toBe(true);
  });

  it('shows FAILED after bounded direct-R2 retries and uses the control plane to abort', async () => {
    setupGlobals(); FakeXHR.statusCode = 503;
    const fetchMock = vi.fn((input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      if (url === '/api/admin/assets/policy') return json(policy);
      if (url === '/api/admin/videos/video-1/assets') return json({ items: [] });
      if (url.endsWith('/assets/uploads')) return json({ sessionId: 'session-fail', assetId: 'asset-fail', mode: 'SINGLE', status: 'UPLOADING', uploadUrl: 'https://edge.r2.cloudflarestorage.com/object?X-Amz-Signature=temporary', requiredHeaders: { 'Content-Type': 'video/mp4' }, expiresAt: '2026-09-11T23:00:00.000Z', sessionExpiresAt: '2026-09-12T00:00:00.000Z', partSizeBytes: null }, 201);
      if (url.includes('/abort') && init?.method === 'POST') return json({ sessionId: 'session-fail', status: 'ABORTED' });
      return json({}, 500);
    });
    vi.stubGlobal('fetch', fetchMock);
    renderAssetManager(); await screen.findByText('No current durable asset in these slots');
    const file = new File([new Uint8Array(64)], 'failed.mp4', { type: 'video/mp4' });
    fireEvent.change(screen.getByLabelText('File'), { target: { files: [file] } });
    fireEvent.click(screen.getByRole('button', { name: 'Upload VIDEO' }));
    expect(await screen.findByText('Failed')).toBeInTheDocument();
    expect(FakeXHR.sends).toBe(3);
    expect(fetchMock.mock.calls.some((call) => String(call[0]).includes('/abort'))).toBe(true);
  });

  it('requests a fresh signed GET and renders a video preview only for a READY R2 video', async () => {
    setupGlobals();
    const asset = readyAsset('VIDEO', 'video/mp4');
    vi.stubGlobal('fetch', vi.fn((input: string | URL | Request) => {
      const url = String(input);
      if (url === '/api/admin/assets/policy') return json(policy);
      if (url === '/api/admin/videos/video-1/assets') return json({ items: [asset] });
      if (url.includes('/download-url')) return json({ assetId: asset.id, downloadUrl: 'https://edge.r2.cloudflarestorage.com/video?X-Amz-Signature=fresh', expiresAt: '2026-09-11T23:00:00.000Z' });
      return json({}, 500);
    }));
    renderAssetManager();
    fireEvent.click(await screen.findByRole('button', { name: 'Preview / Download' }));
    const video = await waitFor(() => document.querySelector('video'));
    expect(video).not.toBeNull();
    expect(video).toHaveAttribute('controls');
    expect(video).toHaveAttribute('src', expect.stringContaining('X-Amz-Signature=fresh'));
  });
});

describe('Phase 5 Channels', () => {
  it('renders real channel/profile data and keeps TikTok avatar-only while YouTube/Facebook expose banner slots', async () => {
    setupGlobals();
    const profiles = ['TIKTOK', 'YOUTUBE', 'FACEBOOK'].map((platform) => ({ id: `profile-${platform.toLowerCase()}`, platform, displayName: `${platform} profile`, username: `@${platform.toLowerCase()}`, assets: [] }));
    vi.stubGlobal('fetch', vi.fn((input: string | URL | Request) => String(input) === '/api/admin/channels'
      ? json({ items: [{ id: 'channel-other', displayName: 'Other Channel', language: 'es-MX', profiles }] })
      : json(policy)));
    const router = createMemoryRouter([{ path: '/channels', element: <ChannelsPage /> }], { initialEntries: ['/channels'] });
    render(<RouterProvider router={router} />);
    expect(await screen.findByText('Other Channel')).toBeInTheDocument();
    for (const platform of ['TIKTOK', 'YOUTUBE', 'FACEBOOK']) expect(screen.getByText(platform)).toBeInTheDocument();
    const tikTok = screen.getByText('TIKTOK').closest('article');
    const youtube = screen.getByText('YOUTUBE').closest('article');
    const facebook = screen.getByText('FACEBOOK').closest('article');
    expect(tikTok).not.toBeNull(); expect(youtube).not.toBeNull(); expect(facebook).not.toBeNull();
    expect(within(tikTok!).getAllByRole('option').map((o) => o.textContent)).toEqual(['AVATAR']);
    expect(within(youtube!).getAllByRole('option').map((o) => o.textContent)).toEqual(['AVATAR', 'BANNER']);
    expect(within(facebook!).getAllByRole('option').map((o) => o.textContent)).toEqual(['AVATAR', 'BANNER']);
  });
});
