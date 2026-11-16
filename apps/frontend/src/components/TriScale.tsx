import type { CSSProperties } from 'react';

/** 综测三段构成（满分 100）：比例即品牌母题 */
export const TRI_DIMS = [
  { key: 'moral', name: '品德', max: 15 },
  { key: 'academic', name: '学业', max: 75 },
  { key: 'sports', name: '文体', max: 10 },
] as const;

type DimKey = (typeof TRI_DIMS)[number]['key'];

const clamp01 = (n: number) => Math.max(0, Math.min(1, n));

/**
 * 三段刻度尺：每段宽度 = 该维度满分占比（15 / 75 / 10），段内填充 = 得分 / 满分。
 * - 不传 values：展示构成（三段满填），用于登录页说明「综测怎么算」。
 * - 传 values：展示个人得分，用于查分页成绩单。
 * 动效：填充用 transform: scaleX（仅合成层），三段依次 80ms 错峰；减弱动态效果时由 CSS 关闭。
 */
export default function TriScale({
  values,
  tone = 'ink',
  className = '',
}: {
  values?: Partial<Record<DimKey, number | null | undefined>>;
  tone?: 'ink' | 'light';
  className?: string;
}) {
  const fmt = (v: number) => (Number.isInteger(v) ? String(v) : v.toFixed(2));
  const items = TRI_DIMS.map((d, i) => {
    const raw = values ? values[d.key] : d.max;
    const v = raw == null || !Number.isFinite(Number(raw)) ? null : Number(raw);
    return { ...d, v, p: v == null ? 0 : clamp01(v / d.max), i };
  });
  const label = items.map((it) => `${it.name} ${it.v == null ? '-' : fmt(it.v)} / ${it.max}`).join('，');

  return (
    <div className={`zc-tri ${tone} ${className}`} role="img" aria-label={values ? `三维得分：${label}` : `综测构成：${label}`}>
      <div className="zc-tri-track" aria-hidden="true">
        {items.map((it) => (
          <span key={it.key} className={`zc-tri-seg ${it.key}`} style={{ '--w': it.max } as CSSProperties}>
            <i style={{ '--p': it.p, '--d': `${it.i * 80}ms` } as CSSProperties} />
          </span>
        ))}
      </div>
      <div className="zc-tri-ticks" aria-hidden="true" />
      <div className="zc-tri-legend" aria-hidden="true">
        {items.map((it) => (
          <span key={it.key} className={`zc-tri-key ${it.key}`}>
            <em />
            {it.name}
            <b className="zc-num">
              {values ? (it.v == null ? '-' : it.v.toFixed(2)) : it.max}
              {values && <small>/{it.max}</small>}
            </b>
          </span>
        ))}
      </div>
    </div>
  );
}
