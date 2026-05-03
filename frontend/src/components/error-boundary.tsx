'use client';

import { Component } from 'react';
import { captureException } from '@/lib/error/sentry';

interface Props {
  children: React.ReactNode;
  fallback?: React.ReactNode;
}

interface State {
  hasError: boolean;
}

export class ErrorBoundary extends Component<Props, State> {
  constructor(props: Props) {
    super(props);
    this.state = { hasError: false };
  }

  static getDerivedStateFromError(): State {
    return { hasError: true };
  }

  override componentDidCatch(error: Error): void {
    captureException(error, { context: 'error-boundary' });
  }

  override render() {
    if (this.state.hasError) {
      return (
        this.props.fallback ?? (
          <div className="flex flex-col items-center justify-center min-h-[50vh] gap-4">
            <h2 className="text-xl font-semibold">组件渲染异常</h2>
            <p className="text-muted-foreground">后端忙碌，请稍后重试</p>
            <button
              onClick={() => this.setState({ hasError: false })}
              className="rounded-md bg-primary px-4 py-2 text-sm text-primary-foreground"
            >
              重试
            </button>
          </div>
        )
      );
    }

    return this.props.children;
  }
}
