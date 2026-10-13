import { Component } from 'react';
import { removeProfileSnapshot } from '../utils/profileSnapshot';

class ErrorBoundary extends Component {
  constructor(props) {
    super(props);
    this.state = { hasError: false };
  }

  static getDerivedStateFromError() {
    return { hasError: true };
  }

  componentDidCatch(error, errorInfo) {
    console.error('Unhandled error in component tree:', error, errorInfo);
    // The fallback renders inside #root, which a server-rendered profile snapshot hides.
    removeProfileSnapshot();
  }

  render() {
    if (this.state.hasError) {
      return (
        <div className="error-boundary">
          <p>Something went wrong.</p>
          <a href="/" className="btn-primary" style={{ textDecoration: 'none' }}>
            Reload Tagstash
          </a>
        </div>
      );
    }

    return this.props.children;
  }
}

export default ErrorBoundary;
