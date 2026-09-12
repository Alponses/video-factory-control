import { useCallback, useEffect, useState } from 'react';
import type { ChannelAssetsDto } from '@contracts';
import { AssetManager } from '../components/AssetManager';
import { EmptyState, ErrorState, LoadingState } from '../components/States';
import { adminApi } from '../lib/api';

export function ChannelsPage() {
  const [data, setData] = useState<ChannelAssetsDto | null>(null);
  const [error, setError] = useState<unknown>(null);

  const load = useCallback(async () => {
    setError(null);
    try { setData(await adminApi.channels()); } catch (caught) { setError(caught); }
  }, []);

  useEffect(() => { void load(); }, [load]);
  if (error) return <section className="page-section"><h1>Canales</h1><ErrorState error={error} action={<button className="button secondary" type="button" onClick={() => void load()}>Retry</button>} /></section>;
  if (!data) return <LoadingState label="Loading channels…" />;
  if (data.items.length === 0) return <section className="page-section"><h1>Canales</h1><EmptyState title="No channels exist in MariaDB" /></section>;

  return <section className="page-section channels-page">
    <header className="page-heading"><div><p className="eyebrow">Profiles</p><h1>Canales</h1><p>Platform-specific avatars and banners stored privately in R2.</p></div></header>
    <div className="channel-stack">{data.items.map((channel) => <section className="panel" key={channel.id}>
      <div className="section-toolbar"><div><h2>{channel.displayName ?? channel.id}</h2><p className="muted">{channel.id} · {channel.language}</p></div></div>
      {channel.profiles.length === 0 ? <EmptyState title="No profiles configured for this channel" /> : <div className="profile-asset-stack">{channel.profiles.map((profile) => <article className="profile-assets" key={profile.id}>
        <div className="profile-assets-heading"><div><strong>{profile.platform}</strong><span>{profile.displayName ?? 'No display name'} · {profile.username ?? 'No handle'}</span></div></div>
        <AssetManager owner={{ type: 'profile', id: profile.id }} allowedKinds={profile.platform === 'TIKTOK' ? ['AVATAR'] : ['AVATAR', 'BANNER']} initialAssets={profile.assets} onChanged={load} />
      </article>)}</div>}
    </section>)}</div>
  </section>;
}
