import { VIDEO_STATUSES, type VideoStatusDto } from '@contracts';

const lifecycle = VIDEO_STATUSES.filter((status) => status !== 'FAILED' && status !== 'CANCELLED');

export function StatusBadge({ status }: { status: string }) {
  return <span className={`status-badge status-${status.toLowerCase()}`}><span aria-hidden="true">●</span>{status}</span>;
}

export function LifecycleProgress({ status }: { status: VideoStatusDto }) {
  const currentIndex = lifecycle.indexOf(status as (typeof lifecycle)[number]);
  const exceptional = status === 'FAILED' || status === 'CANCELLED';
  return (
    <div className="lifecycle" aria-label={`Video lifecycle: ${status}`}>
      {lifecycle.map((step, index) => {
        const state = currentIndex >= 0 && index < currentIndex ? 'complete' : currentIndex === index ? 'current' : 'future';
        return <div className={`lifecycle-step lifecycle-${state}`} key={step}><span aria-hidden="true">{state === 'complete' ? '✓' : state === 'current' ? '●' : '○'}</span><span>{step}</span></div>;
      })}
      {exceptional ? <div className="lifecycle-exception"><StatusBadge status={status} /></div> : null}
    </div>
  );
}
