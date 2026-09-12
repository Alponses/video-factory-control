import { useEffect, useState } from 'react';
import { NavLink, Outlet, useLocation } from 'react-router-dom';
import { adminApi } from '../lib/api';

const futureItems = ['Publicación', 'Métricas', 'Integraciones'];

export function AppShell() {
  const [drawerOpen, setDrawerOpen] = useState(false);
  const [email, setEmail] = useState<string | null>(null);
  const location = useLocation();

  useEffect(() => { setDrawerOpen(false); }, [location.pathname]);
  useEffect(() => {
    let alive = true;
    adminApi.me().then((me) => { if (alive) setEmail(me.email); }).catch(() => { if (alive) setEmail(null); });
    return () => { alive = false; };
  }, []);

  return (
    <div className="admin-shell">
      <a className="skip-link" href="#main-content">Skip to content</a>
      <aside className={`sidebar ${drawerOpen ? 'sidebar-open' : ''}`} aria-label="Primary navigation">
        <div className="brand-block">
          <div className="brand-mark" aria-hidden="true">VF</div>
          <div><strong>Video Factory</strong><span>Admin V5</span></div>
        </div>
        <nav className="nav-list">
          <NavLink to="/" end className={({ isActive }) => isActive ? 'nav-link active' : 'nav-link'}>Resumen</NavLink>
          <NavLink to="/videos" className={({ isActive }) => isActive ? 'nav-link active' : 'nav-link'}>Videos</NavLink>
          <NavLink to="/calendar" className={({ isActive }) => isActive ? 'nav-link active' : 'nav-link'}>Calendario</NavLink>
          <NavLink to="/channels" className={({ isActive }) => isActive ? 'nav-link active' : 'nav-link'}>Canales</NavLink>
          <NavLink to="/workers" className={({ isActive }) => isActive ? 'nav-link active' : 'nav-link'}>Workers</NavLink>
        </nav>
        <div className="future-nav" aria-label="Future sections">
          <span className="future-label">Próximas fases</span>
          {futureItems.map((item) => <span className="nav-link future" key={item}>{item}<small>Disponible en una fase posterior</small></span>)}
        </div>
      </aside>
      {drawerOpen ? <button className="drawer-backdrop" aria-label="Close navigation" onClick={() => setDrawerOpen(false)} /> : null}
      <div className="content-column">
        <header className="topbar">
          <button className="menu-button" type="button" aria-label="Toggle navigation" aria-expanded={drawerOpen} onClick={() => setDrawerOpen((value) => !value)}>☰</button>
          <div className="topbar-title"><strong>Control plane</strong><span>Canal y operaciones reales desde MariaDB</span></div>
          <div className="identity" title={email ?? 'Cloudflare Access identity'}><span aria-hidden="true">●</span>{email ?? 'Access identity'}</div>
        </header>
        <main id="main-content" className="main-content" tabIndex={-1}><Outlet /></main>
      </div>
    </div>
  );
}
