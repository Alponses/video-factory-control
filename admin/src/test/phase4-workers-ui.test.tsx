import type { ReactNode } from 'react';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { createMemoryRouter, RouterProvider } from 'react-router-dom';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { DashboardPage } from '../pages/DashboardPage';
import { WorkersPage } from '../pages/WorkersPage';
import { dashboardFixture, workerFixture, workerListFixture } from './fixtures';

function jsonResponse(body: unknown, status = 200) {
  return Promise.resolve(new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } }));
}

function mockFetch(handler: (url: string, init?: RequestInit) => Promise<Response>) {
  const fn = vi.fn((input: string | URL | Request, init?: RequestInit) => handler(String(input), init));
  vi.stubGlobal('fetch', fn);
  return fn;
}

function renderPage(path: string, element: ReactNode) {
  const router = createMemoryRouter([{ path, element }], { initialEntries: [path] });
  render(<RouterProvider router={router} />);
  return router;
}

beforeEach(() => {
  window.localStorage.clear();
  window.sessionStorage.clear();
});

describe('Dashboard worker summary', () => {
  function dashboardFetch(items: ReturnType<typeof workerFixture>[]) {
    return mockFetch((url) => jsonResponse(url.includes('/api/admin/workers') ? { ...workerListFixture, items } : dashboardFixture));
  }

  it('handles zero workers without fabricating counts or errors', async () => {
    dashboardFetch([]);
    renderPage('/', <DashboardPage />);
    expect(await screen.findByText('Workers online')).toHaveTextContent('Workers online');
    expect(screen.getByText('Workers online').parentElement).toHaveTextContent('0');
    expect(screen.getByText('Workers busy').parentElement).toHaveTextContent('0');
    expect(screen.getByText('No worker errors recorded')).toBeInTheDocument();
  });

  it('counts one ONLINE worker', async () => {
    dashboardFetch([workerFixture('imac-01', 'ONLINE')]);
    renderPage('/', <DashboardPage />);
    expect(await screen.findByText('Workers online')).toBeInTheDocument();
    expect(screen.getByText('Workers online').parentElement).toHaveTextContent('1');
    expect(screen.getByText('Workers busy').parentElement).toHaveTextContent('0');
  });

  it('counts one BUSY worker as online and busy', async () => {
    dashboardFetch([workerFixture('imac-01', 'BUSY')]);
    renderPage('/', <DashboardPage />);
    expect(await screen.findByText('Workers online')).toBeInTheDocument();
    expect(screen.getByText('Workers online').parentElement).toHaveTextContent('1');
    expect(screen.getByText('Workers busy').parentElement).toHaveTextContent('1');
  });

  it('does not count OFFLINE worker as online', async () => {
    dashboardFetch([workerFixture('imac-01', 'OFFLINE')]);
    renderPage('/', <DashboardPage />);
    expect(await screen.findByText('Workers online')).toBeInTheDocument();
    expect(screen.getByText('Workers online').parentElement).toHaveTextContent('0');
  });

  it('surfaces recent worker lastError', async () => {
    dashboardFetch([workerFixture('imac-01', 'ONLINE', { lastError: 'RENDERER_OFFLINE' })]);
    renderPage('/', <DashboardPage />);
    expect(await screen.findByText('RENDERER_OFFLINE')).toBeInTheDocument();
  });
});

describe('Workers admin UI', () => {
  it('shows loading then empty workers state', async () => {
    mockFetch(() => jsonResponse(workerListFixture));
    renderPage('/workers', <WorkersPage />);
    expect(screen.getByText('Loading workers…')).toBeInTheDocument();
    expect(await screen.findByText('No workers registered')).toBeInTheDocument();
  });

  it.each(['ONLINE', 'OFFLINE', 'BUSY', 'DISABLED'] as const)('renders %s status from backend effective status', async (status) => {
    mockFetch(() => jsonResponse({ ...workerListFixture, items: [workerFixture('imac-01', status)] }));
    renderPage('/workers', <WorkersPage />);
    expect(await screen.findByText(status)).toBeInTheDocument();
  });

  it('renders worker last error', async () => {
    mockFetch(() => jsonResponse({ ...workerListFixture, items: [workerFixture('imac-01', 'ONLINE', { lastError: 'RENDERER_OFFLINE' })] }));
    renderPage('/workers', <WorkersPage />);
    expect(await screen.findByText('RENDERER_OFFLINE')).toBeInTheDocument();
  });

  it('creates worker and shows one-time secret only in memory until closed', async () => {
    const secret = 'vfws_test_one_time_secret_012345678901234567890';
    let created = false;
    mockFetch((url, init) => {
      if (url.endsWith('/api/admin/workers') && init?.method === 'POST') {
        created = true;
        return jsonResponse({ worker: workerFixture('imac-01', 'OFFLINE'), secret }, 201);
      }
      return jsonResponse({ ...workerListFixture, items: created ? [workerFixture('imac-01', 'OFFLINE')] : [] });
    });
    const storageSpy = vi.spyOn(Storage.prototype, 'setItem');
    renderPage('/workers', <WorkersPage />);
    await screen.findByText('No workers registered');
    fireEvent.change(screen.getByPlaceholderText('imac-01'), { target: { value: 'imac-01' } });
    fireEvent.click(screen.getByRole('button', { name: 'Create worker' }));
    expect(await screen.findByText(secret)).toBeInTheDocument();
    expect(screen.getByText('Copy this secret now. It will not be shown again.')).toBeInTheDocument();
    expect(storageSpy).not.toHaveBeenCalled();
    expect(window.location.href).not.toContain(secret);
    expect(JSON.stringify(window.localStorage)).not.toContain(secret);
    expect(JSON.stringify(window.sessionStorage)).not.toContain(secret);
    fireEvent.click(screen.getByRole('button', { name: 'Close' }));
    expect(screen.queryByText(secret)).not.toBeInTheDocument();
  });

  it('rotates secret, shows only the new secret, and never reconstructs the old one', async () => {
    const newSecret = 'vfws_rotated_secret_012345678901234567890123456';
    const confirm = vi.spyOn(window, 'confirm').mockReturnValue(true);
    let reads = 0;
    mockFetch((url, init) => {
      if (url.includes('/rotate-secret') && init?.method === 'POST') return jsonResponse({ worker: workerFixture('imac-01', 'ONLINE', { secretVersion: 2 }), secret: newSecret });
      reads += 1;
      return jsonResponse({ ...workerListFixture, items: [workerFixture('imac-01', 'ONLINE', { secretVersion: reads > 1 ? 2 : 1 })] });
    });
    renderPage('/workers', <WorkersPage />);
    await screen.findByText('ONLINE');
    fireEvent.click(screen.getByRole('button', { name: 'Rotate secret' }));
    expect(confirm).toHaveBeenCalled();
    expect(await screen.findByText(newSecret)).toBeInTheDocument();
    expect(document.body.textContent).not.toContain('old-secret');
  });

  it('revokes an enabled worker', async () => {
    vi.spyOn(window, 'confirm').mockReturnValue(true);
    let revoked = false;
    mockFetch((url, init) => {
      if (url.includes('/revoke') && init?.method === 'POST') { revoked = true; return jsonResponse({ worker: workerFixture('imac-01', 'DISABLED') }); }
      return jsonResponse({ ...workerListFixture, items: [workerFixture('imac-01', revoked ? 'DISABLED' : 'ONLINE')] });
    });
    renderPage('/workers', <WorkersPage />);
    await screen.findByText('ONLINE');
    fireEvent.click(screen.getByRole('button', { name: 'Revoke' }));
    expect(await screen.findByText('DISABLED')).toBeInTheDocument();
  });

  it('enables a disabled worker using its current secret version', async () => {
    vi.spyOn(window, 'confirm').mockReturnValue(true);
    let enabled = false;
    mockFetch((url, init) => {
      if (url.includes('/enable') && init?.method === 'POST') { enabled = true; return jsonResponse({ worker: workerFixture('imac-01', 'OFFLINE') }); }
      return jsonResponse({ ...workerListFixture, items: [workerFixture('imac-01', enabled ? 'OFFLINE' : 'DISABLED')] });
    });
    renderPage('/workers', <WorkersPage />);
    await screen.findByText('DISABLED');
    fireEvent.click(screen.getByRole('button', { name: 'Enable' }));
    await waitFor(() => expect(screen.getByText('OFFLINE')).toBeInTheDocument());
  });
});
