import { Spin } from 'antd';

/** 懒加载页面的占位：200ms 内加载完成则什么都不显示，避免快速切页时闪一下转圈 */
export default function RouteFallback() {
  return (
    <div style={{ display: 'flex', justifyContent: 'center', padding: '64px 0' }}>
      <Spin delay={200} />
    </div>
  );
}
