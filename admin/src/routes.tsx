import type { RouteObject } from 'react-router-dom';
import { Link } from 'react-router-dom';
import { AppShell } from './components/Layout';
import { CalendarPage } from './pages/CalendarPage';
import { ChannelsPage } from './pages/ChannelsPage';
import { DashboardPage } from './pages/DashboardPage';
import { VideoDetailPage } from './pages/VideoDetailPage';
import { VideosPage } from './pages/VideosPage';
import { WorkersPage } from './pages/WorkersPage';

function NotFoundPage() {
  return <section className="page-section"><p className="eyebrow">404</p><h1>Page not found</h1><p>The requested admin page does not exist.</p><Link className="button secondary" to="/">Back to dashboard</Link></section>;
}

export const adminRoutes: RouteObject[] = [{
  path: '/',
  element: <AppShell />,
  children: [
    { index: true, element: <DashboardPage /> },
    { path: 'videos', element: <VideosPage /> },
    { path: 'videos/:videoId', element: <VideoDetailPage /> },
    { path: 'calendar', element: <CalendarPage /> },
    { path: 'channels', element: <ChannelsPage /> },
    { path: 'workers', element: <WorkersPage /> },
    { path: '*', element: <NotFoundPage /> },
  ],
}];
