'use client';
import { useEffect, useRef, useState } from 'react';
import { createRefreshQueue } from '../lib/analyticsLive';
import { supabaseBrowserClient } from '../lib/supabaseClient';

type Snapshot = { scope: string; days: number; revision: string; refreshedAt: string };
export function useAnalyticsLive<T extends Snapshot>(initial: T) {
  const [snapshot, setSnapshot] = useState(initial);
  const [status, setStatus] = useState('current');
  const [connected, setConnected] = useState(false);
  const refresh = useRef<() => void>(() => {});
  useEffect(() => {
    setSnapshot(initial);
    let revision = initial.revision;
    let active = true;
    setConnected(false);
    const queue = createRefreshQueue<T>({
      visible: () => document.visibilityState === 'visible',
      state: setStatus,
      read: async signal => {
        const params = new URLSearchParams({ scope: initial.scope, days: String(initial.days), revision });
        const response = await fetch(`/api/analytics/live?${params}`, { cache: 'no-store', credentials: 'same-origin', signal });
        if (response.status === 304) return null;
        if (!response.ok) throw new Error('Analytics unavailable');
        const next: T = await response.json();
        if (next.scope !== initial.scope || next.days !== initial.days || typeof next.revision !== 'string') throw new Error('Invalid analytics response');
        return next;
      },
      apply: next => { revision = next.revision; setSnapshot(next); },
    });
    refresh.current = queue.request;
    const client = supabaseBrowserClient();
    const channel = client?.channel(`analytics:${initial.scope}`, { config: { private: false } })
      .on('broadcast', { event: 'changed' }, queue.request)
      .subscribe(state => {
        if (!active) return;
        setConnected(state === 'SUBSCRIBED');
        if (state === 'SUBSCRIBED') queue.request();
      });
    const auth = client?.auth.onAuthStateChange(() => queue.request());
    const timer = window.setInterval(queue.request, 30_000);
    // Visibility recovery also catches missed events and a UTC window rollover.
    document.addEventListener('visibilitychange', queue.request);
    window.addEventListener('online', queue.request);
    window.addEventListener('focus', queue.request);
    queue.request();
    return () => {
      active = false; queue.stop(); window.clearInterval(timer); refresh.current = () => {};
      document.removeEventListener('visibilitychange', queue.request);
      window.removeEventListener('online', queue.request);
      window.removeEventListener('focus', queue.request);
      auth?.data.subscription.unsubscribe();
      if (channel && client) void client.removeChannel(channel);
    };
  }, [initial]);
  return { snapshot, status, connected, refresh: () => refresh.current() };
}
export function AnalyticsLiveStatus({ live }: { live: ReturnType<typeof useAnalyticsLive> }) {
  return <div className="campaign-ledger-note" data-analytics-revision={live.snapshot.revision}>
    <span role="status" aria-live="polite">{live.status === 'error' ? 'Update failed · retrying automatically' : live.status === 'updating' ? 'Updating records…' : live.connected ? 'Live updates connected' : 'Automatic updates · checking every 30 seconds'}</span>
    {' · '}Records loaded <time dateTime={live.snapshot.refreshedAt}>{new Date(live.snapshot.refreshedAt).toLocaleString('en-GB', { timeZone: 'Europe/Berlin' })} Berlin</time>
    {' · '}<button type="button" onClick={live.refresh} disabled={live.status === 'updating'}>Refresh records</button>
    <p>Record updates reflect stored sends and captured replies. LinkedIn reply coverage changes only when an inbox scan completes.</p>
  </div>;
}
