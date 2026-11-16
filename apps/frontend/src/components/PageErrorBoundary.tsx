import { Component, type ErrorInfo, type ReactNode } from 'react';
import { Button, Result } from 'antd';

/**
 * 页面级错误兜底：单个页面渲染出错时只替换内容区，侧栏/导航仍可用，不再整站白屏。
 * 由布局以 key=路由 挂载，切换页面即自动复位；「重新加载本页」重挂子树（或整页刷新兜底懒加载失败）。
 */
export default class PageErrorBoundary extends Component<{ children: ReactNode }, { error: Error | null; attempt: number }> {
  state = { error: null as Error | null, attempt: 0 };

  static getDerivedStateFromError(error: Error) {
    return { error };
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    // 保留到控制台，便于定位（生产环境同样有用）
    console.error('[页面渲染出错]', error, info.componentStack);
  }

  private retry = () => {
    // 懒加载 chunk 失败（发版后旧页面拿不到新文件）时，重挂无效，只能整页刷新
    if (/dynamically imported module|Loading chunk|Importing a module script failed/i.test(this.state.error?.message ?? '')) {
      window.location.reload();
      return;
    }
    this.setState((s) => ({ error: null, attempt: s.attempt + 1 }));
  };

  render() {
    if (this.state.error) {
      return (
        <Result
          status="warning"
          title="页面出错了"
          subTitle={`这个页面没能显示出来。可以重新加载，或先去其他页面。${this.state.error.message ? `（${this.state.error.message.slice(0, 120)}）` : ''}`}
          extra={
            <Button type="primary" onClick={this.retry}>
              重新加载本页
            </Button>
          }
        />
      );
    }
    return <div key={this.state.attempt}>{this.props.children}</div>;
  }
}
