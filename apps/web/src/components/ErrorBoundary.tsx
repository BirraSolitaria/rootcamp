import { Component, type ErrorInfo, type ReactNode } from 'react';
import { ApiClientError } from '../api/client';
import { ErrorScreen } from './ErrorScreen';

type State = { error: unknown };

/** Catches render errors and 5xx thrown by queries (`throwOnError`) → `ErrorScreen`. */
export class ErrorBoundary extends Component<{ children: ReactNode }, State> {
  state: State = { error: null };

  static getDerivedStateFromError(error: unknown): State {
    return { error };
  }

  componentDidCatch(error: unknown, info: ErrorInfo) {
    console.error('Unhandled UI error', error, info.componentStack);
  }

  render() {
    const { error } = this.state;
    if (!error) return this.props.children;
    const reqId = error instanceof ApiClientError ? error.reqId : undefined;
    return <ErrorScreen reqId={reqId} />;
  }
}
