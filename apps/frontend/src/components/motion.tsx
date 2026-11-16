import { useLayoutEffect, useRef } from 'react';

/** 系统「减弱动态效果」开关（只在调用时读一次，不订阅变化——足够用于一次性入场动画） */
export const prefersReducedMotion = () =>
  typeof window !== 'undefined' && !!window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;

/** easeOutExpo：快速冲到接近终值再缓停，数字滚动不会在末尾拖沓 */
const easeOutExpo = (t: number) => (t >= 1 ? 1 : 1 - Math.pow(2, -10 * t));

/**
 * 数字滚动（成绩单总分揭示，低频一次性场景）。
 * 性能：rAF 内直接写 textContent，不走 React setState，不触发组件重渲染；
 * 宽度按终值字符数预留（配合 tabular-nums），滚动过程中不引起布局抖动。
 * 可访问性：读屏只读终值；减弱动态效果时直接显示终值。
 */
export function CountUp({ value, decimals = 2, duration = 900 }: { value: number; decimals?: number; duration?: number }) {
  const ref = useRef<HTMLSpanElement>(null);
  const final = value.toFixed(decimals);

  // layout effect：在首帧绘制前把数字归零，避免「先闪终值再从 0 滚」
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    if (prefersReducedMotion() || !Number.isFinite(value)) {
      el.textContent = final;
      return;
    }
    let raf = 0;
    const t0 = performance.now();
    el.textContent = (0).toFixed(decimals);
    const tick = (now: number) => {
      const t = Math.min(1, (now - t0) / duration);
      el.textContent = (value * easeOutExpo(t)).toFixed(decimals);
      if (t < 1) raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => {
      cancelAnimationFrame(raf);
      el.textContent = final;
    };
  }, [value, decimals, duration, final]);

  return (
    <>
      <span className="zc-sr-only">{final}</span>
      <span ref={ref} aria-hidden="true" style={{ display: 'inline-block', minWidth: `${final.length * 0.6}em` }}>
        {final}
      </span>
    </>
  );
}
