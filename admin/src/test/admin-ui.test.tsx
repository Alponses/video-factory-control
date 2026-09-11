import type { ReactNode } from 'react';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { createMemoryRouter, RouterProvider } from 'react-router-dom';
import { describe, expect, it, vi } from 'vitest';
import { DashboardPage } from '../pages/DashboardPage';
import { VideosPage } from '../pages/VideosPage';
import { VideoDetailPage } from '../pages/VideoDetailPage';
import { dashboardFixture, detailFixture, listFixture } from './fixtures';

function jsonResponse(body: unknown, status = 200, headers: Record<string, string> = {}) {
  return Promise.resolve(new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', ...headers } }));
}

function mockFetch(handler: (url: string, init?: RequestInit) => Promise<Response>) {
  const fn = vi.fn((input: string | URL | Request, init?: RequestInit) => handler(String(input), init));
  vi.stubGlobal('fetch', fn);
  return fn;
}

function renderRoute(path: string, routePath: string, element: ReactNode, extraRoutes: Array<{ path: string; element: ReactNode }> = []) {
  const router = createMemoryRouter([{ path: routePath, element }, ...extraRoutes], { initialEntries: [path] });
  render(<RouterProvider router={router} />);
  return router;
}

describe('Dashboard', () => {
  it('renders real API counts including zero values', async () => {
    mockFetch(() => jsonResponse(dashboardFixture));
    renderRoute('/', '/', <DashboardPage />);
    expect(await screen.findByText('11')).toBeInTheDocument();
    expect(screen.getByText('QUEUED').parentElement).toHaveTextContent('0');
    expect(screen.getByText('Legacy incomplete').parentElement).toHaveTextContent('1');
  });

  it.each([
    [401, 'Access session invalid'],
    [403, 'Access denied'],
    [429, 'Too many requests'],
  ])('renders HTTP %s state', async (status, title) => {
    mockFetch(() => jsonResponse({ error: { code: 'X', message: 'failed' } }, status));
    renderRoute('/', '/', <DashboardPage />);
    expect(await screen.findByText(title)).toBeInTheDocument();
  });

  it('shows requestId on server errors', async () => {
    mockFetch(() => jsonResponse({ error: { code: 'INTERNAL_ERROR', message: 'failed', requestId: 'req-123' } }, 500));
    renderRoute('/', '/', <DashboardPage />);
    expect(await screen.findByText(/req-123/)).toBeInTheDocument();
  });
});

describe('Video library', () => {
  it('shows loading state', () => {
    mockFetch(() => new Promise<Response>(() => {}));
    renderRoute('/videos', '/videos', <VideosPage />);
    expect(screen.getByText('Loading videos…')).toBeInTheDocument();
  });

  it('shows empty state', async () => {
    mockFetch(() => jsonResponse({ ...listFixture, items: [], total: 0 }));
    renderRoute('/videos', '/videos', <VideosPage />);
    expect(await screen.findByText('No videos match these filters')).toBeInTheDocument();
  });

  it('keeps search/filter state in URL and sends it server-side', async () => {
    const fetchMock = mockFetch(() => jsonResponse({ ...listFixture, page: 2 }));
    renderRoute('/videos?status=APPROVED&category=fe&page=2&q=oracion', '/videos', <VideosPage />);
    await screen.findByText('Una pausa');
    expect(fetchMock).toHaveBeenCalled();
    const url = String(fetchMock.mock.calls[0]?.[0]);
    expect(url).toContain('page=2');
    expect(url).toContain('search=oracion');
    expect(url).toContain('status=APPROVED');
    expect(url).toContain('category=fe');
  });

  it('does not fabricate thumbnail images', async () => {
    mockFetch(() => jsonResponse(listFixture));
    renderRoute('/videos', '/videos', <VideosPage />);
    expect(await screen.findAllByText('No thumbnail')).not.toHaveLength(0);
    expect(document.querySelector('img')).toBeNull();
  });
});

describe('Video detail', () => {
  it('renders detail data', async () => {
    mockFetch(() => jsonResponse(detailFixture()));
    renderRoute('/videos/religion-000011', '/videos/:videoId', <VideoDetailPage />);
    expect((await screen.findAllByText('Una pausa con fe')).length).toBeGreaterThan(0);
    expect((await screen.findAllByText('Pausa con Fe')).length).toBeGreaterThan(0);
    expect(screen.getByText('oracion')).toBeInTheDocument();
  });

  it('preserves religion-000001 as legacy incomplete with zero scenes', async () => {
    mockFetch(() => jsonResponse(detailFixture('religion-000001', 0)));
    renderRoute('/videos/religion-000001?tab=scenes', '/videos/:videoId', <VideoDetailPage />);
    expect(await screen.findByText('No historical scenes exist. Video Factory does not fabricate missing scene data.')).toBeInTheDocument();
    expect(screen.getByRole('tab', { name: 'Escenas (0)' })).toBeInTheDocument();
  });

  it('saves video edits and updates the versioned view', async () => {
    const detail = detailFixture();
    mockFetch((_url, init) => {
      if (init?.method === 'PATCH') return jsonResponse({ title: 'Updated title', category: 'fe', primaryKeyword: 'oracion', searchIntent: 'oración de noche', hookText: 'Respira un momento', hookType: 'calm', closing: 'Descansa', cta: 'Comparte', question: '¿Qué agradeces hoy?', pinnedComment: 'Amén', version: 5 });
      return jsonResponse(detail);
    });
    renderRoute('/videos/religion-000011?tab=content', '/videos/:videoId', <VideoDetailPage />);
    fireEvent.click(await screen.findByRole('button', { name: 'Edit' }));
    fireEvent.change(screen.getByLabelText('Title'), { target: { value: 'Updated title' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    expect((await screen.findAllByText('Updated title')).length).toBeGreaterThan(0);
  });

  it('shows video validation errors before sending', async () => {
    mockFetch(() => jsonResponse(detailFixture()));
    renderRoute('/videos/religion-000011?tab=content', '/videos/:videoId', <VideoDetailPage />);
    fireEvent.click(await screen.findByRole('button', { name: 'Edit' }));
    fireEvent.change(screen.getByLabelText('Title'), { target: { value: '' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    expect(await screen.findByText('Title and category are required.')).toBeInTheDocument();
  });

  it('shows explicit video 409 conflict UX without automatic retry', async () => {
    const fetchMock = mockFetch((_url, init) => init?.method === 'PATCH'
      ? jsonResponse({ error: { code: 'VIDEO_VERSION_CONFLICT', message: 'conflict' } }, 409)
      : jsonResponse(detailFixture()));
    renderRoute('/videos/religion-000011?tab=content', '/videos/:videoId', <VideoDetailPage />);
    fireEvent.click(await screen.findByRole('button', { name: 'Edit' }));
    fireEvent.change(screen.getByLabelText('Title'), { target: { value: 'Unsaved title' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    expect(await screen.findByText('Este video cambió desde que lo abriste.')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Reload latest version' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Copy my unsaved changes' })).toBeInTheDocument();
    expect(fetchMock.mock.calls.filter((call) => (call[1] as RequestInit | undefined)?.method === 'PATCH')).toHaveLength(1);
  });

  it('saves a scene edit', async () => {
    const detail = detailFixture();
    mockFetch((_url, init) => init?.method === 'PATCH'
      ? jsonResponse({ id: 'scene-0', position: 0, text: 'Updated scene', searchTerms: ['paz'], version: 2, updatedAt: '2026-09-11T12:00:00.000Z' })
      : jsonResponse(detail));
    renderRoute('/videos/religion-000011?tab=scenes', '/videos/:videoId', <VideoDetailPage />);
    fireEvent.click(await screen.findByRole('button', { name: 'Edit' }));
    fireEvent.change(screen.getByLabelText('Text'), { target: { value: 'Updated scene' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    expect(await screen.findByText('Updated scene')).toBeInTheDocument();
  });

  it('shows scene conflict UX', async () => {
    mockFetch((_url, init) => init?.method === 'PATCH'
      ? jsonResponse({ error: { code: 'SCENE_VERSION_CONFLICT', message: 'conflict' } }, 409)
      : jsonResponse(detailFixture()));
    renderRoute('/videos/religion-000011?tab=scenes', '/videos/:videoId', <VideoDetailPage />);
    fireEvent.click(await screen.findByRole('button', { name: 'Edit' }));
    fireEvent.change(screen.getByLabelText('Text'), { target: { value: 'Unsaved scene' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    expect(await screen.findByText('Esta escena cambió desde que la abriste.')).toBeInTheDocument();
  });

  it('shows publication conflict UX when editorial metadata is edited', async () => {
    mockFetch((_url, init) => init?.method === 'PATCH'
      ? jsonResponse({ error: { code: 'PUBLICATION_VERSION_CONFLICT', message: 'conflict' } }, 409)
      : jsonResponse(detailFixture()));
    renderRoute('/videos/religion-000011?tab=publication', '/videos/:videoId', <VideoDetailPage />);
    fireEvent.click(await screen.findByRole('button', { name: 'Edit metadata' }));
    fireEvent.change(screen.getByLabelText('Title'), { target: { value: 'New platform title' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    expect(await screen.findByText('Esta publicación cambió desde que la abriste.')).toBeInTheDocument();
  });

  it('warns before SPA navigation with unsaved changes', async () => {
    mockFetch(() => jsonResponse(detailFixture()));
    const confirm = vi.spyOn(window, 'confirm').mockReturnValue(false);
    renderRoute('/videos/religion-000011?tab=content', '/videos/:videoId', <VideoDetailPage />, [{ path: '/videos', element: <div>Destination</div> }]);
    fireEvent.click(await screen.findByRole('button', { name: 'Edit' }));
    fireEvent.change(screen.getByLabelText('Title'), { target: { value: 'Unsaved title' } });
    fireEvent.click(screen.getByRole('link', { name: '← Videos' }));
    await waitFor(() => expect(confirm).toHaveBeenCalled());
    expect(screen.getByDisplayValue('Unsaved title')).toBeInTheDocument();
  });

  it('does not fabricate metrics', async () => {
    mockFetch(() => jsonResponse(detailFixture()));
    renderRoute('/videos/religion-000011?tab=metrics', '/videos/:videoId', <VideoDetailPage />);
    expect(await screen.findByText('No metrics collected yet.')).toBeInTheDocument();
    expect(screen.queryByText(/123,?456 views/i)).not.toBeInTheDocument();
  });
});
