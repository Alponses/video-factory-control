import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { createMemoryRouter, RouterProvider } from 'react-router-dom';
import { describe, expect, it, vi } from 'vitest';
import { VideoDetailPage } from '../pages/VideoDetailPage';
import { detailFixture } from './fixtures';

function jsonResponse(body: unknown, status = 200) {
  return Promise.resolve(new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } }));
}

function renderDetail(detail = detailFixture()) {
  const router = createMemoryRouter([{ path: '/videos/:videoId', element: <VideoDetailPage /> }], { initialEntries: [`/videos/${detail.video.id}?tab=render`] });
  render(<RouterProvider router={router} />);
  return router;
}

describe('Phase 4 render operations UI', () => {
  it('shows Queue render only for an initially queueable state and reloads after success', async () => {
    const initial = detailFixture();
    initial.video.status = 'READY';
    const queued = detailFixture();
    queued.video.status = 'QUEUED';
    queued.video.version = initial.video.version + 1;
    let reads = 0;
    const fetchMock = vi.fn((input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      if (url.endsWith('/queue-render') && init?.method === 'POST') return jsonResponse({ id: initial.video.id, status: 'QUEUED', version: queued.video.version });
      reads += 1;
      return jsonResponse(reads === 1 ? initial : queued);
    });
    vi.stubGlobal('fetch', fetchMock);
    vi.spyOn(window, 'confirm').mockReturnValue(true);
    renderDetail(initial);
    const button = await screen.findByRole('button', { name: 'Queue render' });
    expect(screen.queryByRole('button', { name: 'Re-render' })).not.toBeInTheDocument();
    fireEvent.click(button);
    await waitFor(() => expect(fetchMock.mock.calls.some((call) => String(call[0]).endsWith('/queue-render') && (call[1] as RequestInit | undefined)?.method === 'POST')).toBe(true));
    await screen.findByText('No render action is valid while the video is QUEUED.');
  });

  it.each(['FAILED', 'APPROVED'] as const)('shows Re-render for %s', async (status) => {
    const detail = detailFixture();
    detail.video.status = status;
    vi.stubGlobal('fetch', vi.fn(() => jsonResponse(detail)));
    renderDetail(detail);
    expect(await screen.findByRole('button', { name: 'Re-render' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Queue render' })).not.toBeInTheDocument();
  });

  it('does not offer Re-render for PUBLISHED', async () => {
    const detail = detailFixture();
    detail.video.status = 'PUBLISHED';
    vi.stubGlobal('fetch', vi.fn(() => jsonResponse(detail)));
    renderDetail(detail);
    expect(await screen.findByText('No render action is valid while the video is PUBLISHED.')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Re-render' })).not.toBeInTheDocument();
  });

  it('handles version 409 without automatic retry or overwrite', async () => {
    const detail = detailFixture();
    detail.video.status = 'READY';
    const fetchMock = vi.fn((input: string | URL | Request, init?: RequestInit) => {
      if (String(input).endsWith('/queue-render') && init?.method === 'POST') return jsonResponse({ error: { code: 'VIDEO_VERSION_CONFLICT', message: 'conflict' } }, 409);
      return jsonResponse(detail);
    });
    vi.stubGlobal('fetch', fetchMock);
    vi.spyOn(window, 'confirm').mockReturnValue(true);
    renderDetail(detail);
    fireEvent.click(await screen.findByRole('button', { name: 'Queue render' }));
    expect(await screen.findByText('This video changed since you loaded it.')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Reload latest version' })).toBeInTheDocument();
    expect(fetchMock.mock.calls.filter((call) => String(call[0]).endsWith('/queue-render'))).toHaveLength(1);
  });

  it('shows every historical RenderAttempt with its own QA and error data', async () => {
    const detail = detailFixture();
    detail.renderAttempts = [
      { ...detail.renderAttempts[0]!, id: 'attempt-2', attempt: 2, status: 'FAILED', workerId: 'imac-02', workerLabel: null, rendererVideoId: 'renderer-2', error: 'LEASE_EXPIRED' },
      { ...detail.renderAttempts[0]!, id: 'attempt-1', attempt: 1, status: 'SUCCEEDED', workerId: 'imac-01', workerLabel: null, rendererVideoId: 'renderer-1', error: null },
    ];
    detail.qa = [
      { ...detail.qa[0]!, id: 'qa-2', attempt: 2, passed: false, durationPassed: true, resolutionPassed: true, audioPassed: false, captionsPassed: null },
      { ...detail.qa[0]!, id: 'qa-1', attempt: 1, passed: true, durationPassed: true, resolutionPassed: true, audioPassed: true, captionsPassed: null },
    ];
    vi.stubGlobal('fetch', vi.fn(() => jsonResponse(detail)));
    renderDetail(detail);
    expect(await screen.findByText('Render Attempt #2')).toBeInTheDocument();
    expect(screen.getByText('Render Attempt #1')).toBeInTheDocument();
    expect(screen.getByText('imac-02')).toBeInTheDocument();
    expect(screen.getByText('renderer-2')).toBeInTheDocument();
    expect(screen.getByText('LEASE_EXPIRED')).toBeInTheDocument();
    expect(screen.getAllByText('Unknown').length).toBeGreaterThanOrEqual(2);
  });
});
