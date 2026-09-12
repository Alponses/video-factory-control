import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { createMemoryRouter, RouterProvider } from 'react-router-dom';
import { describe, expect, it, vi } from 'vitest';
import type { PublicationPreflightDto } from '@contracts';
import { ScheduleControls } from '../components/ScheduleControls';
import { CalendarPage } from '../pages/CalendarPage';
import { detailFixture } from './fixtures';

function jsonResponse(body: unknown, status = 200) {
  return Promise.resolve(new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } }));
}

const calendarItem = {
  scheduleId: 'schedule-1', publicationId: 'pub-1', videoId: 'religion-000011', channelId: 'religion-es', title: 'Una pausa con fe', platform: 'TIKTOK' as const,
  status: 'SCHEDULED' as const, scheduledAtUtc: '2026-09-16T02:30:00.000Z', localDateTime: '2026-09-15T20:30:00', timezone: 'America/Mexico_City', publicationStatus: 'SCHEDULED', version: 3, dispatch: null,
};

const readyPreflight: PublicationPreflightDto = {
  ready: true,
  blockers: [], warnings: [],
  preview: { publicationId: 'pub-1', videoId: 'religion-000011', platform: 'TIKTOK', profileId: 'profile-1', title: 'TikTok title', caption: 'Caption', description: 'Description', hashtags: ['#Fe', '#Paz', '#Esperanza', '#PausaConFe'], cta: 'Comparte', videoAssetId: 'r2-video-1', coverAssetId: null, thumbnailAssetId: null, durationSeconds: 65, internalRuleNotice: 'Video Factory internal pipeline rules.' },
  activeSchedule: null,
  latestDispatch: null,
};

function renderCalendar(entry = '/calendar?view=month&date=2026-09-15') {
  const router = createMemoryRouter([{ path: '/calendar', element: <CalendarPage /> }], { initialEntries: [entry] });
  render(<RouterProvider router={router} />);
  return router;
}

describe('Phase 6 Calendar UI', () => {
  it('shows loading and explicit empty state', async () => {
    let resolveFetch!: (response: Response) => void;
    vi.stubGlobal('fetch', vi.fn(() => new Promise<Response>((resolve) => { resolveFetch = resolve; })));
    renderCalendar();
    expect(screen.getByText('Loading calendar…')).toBeInTheDocument();
    resolveFetch(new Response(JSON.stringify({ items: [] }), { status: 200 }));
    expect(await screen.findByText('No scheduled publications.')).toBeInTheDocument();
  });

  it('renders month events with platform, timezone and has no Publish Now action', async () => {
    vi.stubGlobal('fetch', vi.fn(() => jsonResponse({ items: [calendarItem] })));
    renderCalendar();
    expect(await screen.findByText(/20:30 · Una pausa con fe/)).toBeInTheDocument();
    expect(screen.getByText(/SCHEDULED · America\/Mexico_City/)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /publish now/i })).not.toBeInTheDocument();
  });

  it('keeps view/platform/status/channel filters in URL and sends them server-side', async () => {
    const fetchMock = vi.fn(() => jsonResponse({ items: [calendarItem] }));
    vi.stubGlobal('fetch', fetchMock);
    const router = renderCalendar();
    await screen.findByText(/20:30 · Una pausa con fe/);
    fireEvent.click(screen.getByRole('button', { name: 'Week' }));
    fireEvent.change(screen.getByLabelText('Platform'), { target: { value: 'TIKTOK' } });
    fireEvent.change(screen.getByLabelText('Status'), { target: { value: 'SCHEDULED' } });
    fireEvent.change(screen.getByLabelText('Channel'), { target: { value: 'religion-es' } });
    await waitFor(() => expect(router.state.location.search).toContain('view=week'));
    await waitFor(() => expect(fetchMock.mock.calls.some((call) => {
      const url = String(call[0]);
      return url.includes('platform=TIKTOK') && url.includes('status=SCHEDULED') && url.includes('channelId=religion-es');
    })).toBe(true));
  });

  it('reschedules from event detail with expectedVersion and does not retry 409 automatically', async () => {
    let patchCalls = 0;
    const fetchMock = vi.fn((input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      if (url.includes('/api/admin/calendar')) return jsonResponse({ items: [calendarItem] });
      if (url.endsWith('/api/admin/schedules/schedule-1') && init?.method === 'PATCH') {
        patchCalls += 1;
        return jsonResponse({ error: { code: 'SCHEDULE_VERSION_CONFLICT', message: 'conflict' } }, 409);
      }
      return jsonResponse({});
    });
    vi.stubGlobal('fetch', fetchMock);
    renderCalendar();
    fireEvent.click(await screen.findByRole('button', { name: /TikTok.*20:30.*Una pausa with fe/i }).catch(() => screen.getByText(/20:30 · Una pausa con fe/).closest('button')!));
    fireEvent.change(screen.getByLabelText('Date and time'), { target: { value: '2026-09-15T21:00' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save schedule' }));
    expect(await screen.findByText('Schedule version conflict.')).toBeInTheDocument();
    expect(patchCalls).toBe(1);
  });

  it('cancels an active schedule from the event panel', async () => {
    const fetchMock = vi.fn((input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      if (url.includes('/api/admin/calendar')) return jsonResponse({ items: [calendarItem] });
      if (url.endsWith('/cancel') && init?.method === 'POST') return jsonResponse({ schedule: { ...calendarItem, id: 'schedule-1', publicationId: 'pub-1', status: 'CANCELLED', version: 4, createdAt: '2026-09-01T00:00:00Z', updatedAt: '2026-09-01T00:00:00Z' }, publicationStatus: 'READY', publicationVersion: 4 });
      return jsonResponse({});
    });
    vi.stubGlobal('fetch', fetchMock);
    vi.spyOn(window, 'confirm').mockReturnValue(true);
    renderCalendar();
    const event = await screen.findByText(/20:30 · Una pausa con fe/);
    fireEvent.click(event.closest('button')!);
    fireEvent.click(screen.getByRole('button', { name: 'Cancel schedule' }));
    await waitFor(() => expect(fetchMock.mock.calls.some((call) => String(call[0]).endsWith('/api/admin/schedules/schedule-1/cancel'))).toBe(true));
  });
});

describe('Phase 6 Publication schedule controls', () => {
  it('shows preflight blockers and disables scheduling when publication is not ready', async () => {
    const publication = detailFixture().publications[0]!;
    vi.stubGlobal('fetch', vi.fn(() => jsonResponse({ ...readyPreflight, ready: false, blockers: [{ code: 'DURABLE_VIDEO_MISSING', message: 'A current READY R2 VIDEO asset is required.' }] })));
    render(<ScheduleControls publication={publication} onReload={vi.fn()} onDirtyChange={vi.fn()} />);
    expect(await screen.findByText(/DURABLE_VIDEO_MISSING/)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Schedule' })).toBeDisabled();
  });

  it('schedules with explicit localDateTime timezone and publication expectedVersion', async () => {
    const publication = detailFixture().publications[0]!;
    const fetchMock = vi.fn((input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      if (url.endsWith('/preflight')) return jsonResponse(readyPreflight);
      if (url.endsWith('/schedule') && init?.method === 'POST') return jsonResponse({ schedule: { id: 'schedule-new', publicationId: publication.id, status: 'SCHEDULED', version: 1, scheduledAtUtc: '2026-09-16T02:30:00Z', localDateTime: '2026-09-15T20:30:00', timezone: 'America/Mexico_City', createdAt: '2026-09-12T00:00:00Z', updatedAt: '2026-09-12T00:00:00Z' }, publicationVersion: publication.version + 1 }, 201);
      return jsonResponse({});
    });
    vi.stubGlobal('fetch', fetchMock);
    render(<ScheduleControls publication={publication} onReload={vi.fn().mockResolvedValue(undefined)} onDirtyChange={vi.fn()} />);
    fireEvent.change(await screen.findByLabelText('TIKTOK schedule date and time'), { target: { value: '2026-09-15T20:30' } });
    fireEvent.click(screen.getByRole('button', { name: 'Schedule' }));
    await waitFor(() => {
      const call = fetchMock.mock.calls.find((item) => String(item[0]).endsWith('/schedule'));
      expect(call).toBeTruthy();
      const body = JSON.parse(String((call![1] as RequestInit).body));
      expect(body).toEqual({ localDateTime: '2026-09-15T20:30:00', timezone: 'America/Mexico_City', expectedVersion: publication.version });
    });
    expect(screen.queryByRole('button', { name: /publish now/i })).not.toBeInTheDocument();
  });
});
