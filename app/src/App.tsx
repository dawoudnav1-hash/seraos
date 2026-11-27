import { Component, useEffect, useMemo, type ErrorInfo, type ReactNode } from 'react';
import { Toasts } from './components/events';
import { loadData } from './dataSource';
import { AppDataProvider, useAppData } from './state/AppData';
import { useHashRoute, type View } from './state/router';
import { Accounts } from './views/Accounts';
import { Contacts } from './views/Contacts';
import { Dashboard } from './views/Dashboard';
import { Outreach } from './views/Outreach';
import { Settings } from './views/Settings';

const NAV: readonly { id: View; label: string }[] = [
  { id: 'dashboard', label: 'Dashboard' },
  { id: 'accounts', label: 'Accounts' },
  { id: 'contacts', label: 'Contacts' },
  { id: 'outreach', label: 'Outreach' },
  { id: 'settings', label: 'Data' },
];

class ErrorBoundary extends Component<{ children: ReactNode }, { error: Error | null }> {
  override state = { error: null as Error | null };
  static getDerivedStateFromError(error: Error) {
    return { error };
  }
  override componentDidCatch(error: Error, info: ErrorInfo) {
    console.warn('View crashed', error, info.componentStack);
  }
  override render() {
    if (this.state.error) {
      return (
        <div className="page">
          <div className="note note-warn" role="alert">
            Something went wrong rendering this view: {this.state.error.message}.{' '}
            <button type="button" className="btn btn-sm" onClick={() => this.setState({ error: null })}>
              Try again
            </button>
          </div>
        </div>
      );
    }
    return this.props.children;
  }
}

function Shell() {
  const route = useHashRoute();
  const { accounts, index, manualEvents, storageOk } = useAppData();
  const contacts = useMemo(() => accounts.reduce((n, a) => n + a.contacts.length, 0), [accounts]);

  useEffect(() => {
    const label = NAV.find((n) => n.id === route.view)?.label ?? 'Dashboard';
    document.title = `${label} · Vert prospects`;
  }, [route.view]);

  return (
    <>
      <header className="topbar">
        <div className="brand">
          <span className="brand-mark" aria-hidden="true">V</span>
          <span className="brand-name">Vert prospects</span>
        </div>
        <nav className="nav" aria-label="Main">
          {NAV.map((n) => (
            <a key={n.id} href={`#/${n.id}`} className={route.view === n.id ? 'active' : ''} aria-current={route.view === n.id ? 'page' : undefined} data-testid={`nav-${n.id}`}>
              {n.label}
              {n.id === 'accounts' && <span className="nav-count">{accounts.length}</span>}
              {n.id === 'contacts' && <span className="nav-count">{contacts}</span>}
            </a>
          ))}
        </nav>
        <div className="topbar-meta">
          {!storageOk && <span className="badge badge-warn" title="Manual events will not persist">storage off</span>}
          <span className="muted small">
            {index.byAccount.size} touched · {manualEvents.length} manual
          </span>
        </div>
      </header>
      <main className="main">
        <ErrorBoundary key={route.view}>
          {route.view === 'dashboard' && <Dashboard />}
          {route.view === 'accounts' && <Accounts route={route} />}
          {route.view === 'contacts' && <Contacts />}
          {route.view === 'outreach' && <Outreach route={route} />}
          {route.view === 'settings' && <Settings />}
        </ErrorBoundary>
      </main>
      <Toasts />
    </>
  );
}

const data = loadData();

export function App() {
  return (
    <AppDataProvider data={data}>
      <Shell />
    </AppDataProvider>
  );
}
