import { randomBytes } from 'node:crypto';

/** 无歧义字符集（去掉 0O1I 等） */
const CHARS = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
const rnd = (n: number) => randomBytes(1)[0] % n;

/** 手写 SVG 图形验证码：4 位字符，随机旋转/偏移/色相 + 噪声路径（零依赖） */
export function genCaptchaSvg(): { text: string; svg: string } {
  const text = [...randomBytes(4)].map((b) => CHARS[b % CHARS.length]).join('');
  const W = 120;
  const H = 44;

  let glyphs = '';
  [...text].forEach((ch, i) => {
    const x = 16 + i * 24 + rnd(8) - 4;
    const y = 30 + rnd(6) - 3;
    const rot = rnd(30) - 15;
    const hue = 200 + rnd(70);
    glyphs += `<text x="${x}" y="${y}" font-size="${24 + rnd(7)}" font-family="Georgia,'Times New Roman',serif" font-weight="bold" fill="hsl(${hue},55%,38%)" transform="rotate(${rot} ${x} ${y})">${ch}</text>`;
  });

  let noise = '';
  for (let i = 0; i < 5; i++) {
    const x1 = rnd(W);
    const y1 = rnd(H);
    noise += `<path d="M${x1} ${y1} q ${10 + rnd(30)} ${rnd(30) - 15} ${20 + rnd(50)} ${rnd(24) - 12}" stroke="hsl(${180 + rnd(80)},45%,55%)" stroke-width="1" fill="none" opacity="0.45"/>`;
  }
  for (let i = 0; i < 3; i++) {
    noise += `<circle cx="${rnd(W)}" cy="${rnd(H)}" r="1.5" fill="hsl(${rnd(360)},40%,60%)" opacity="0.6"/>`;
  }

  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}" role="img" aria-label="验证码"><rect width="100%" height="100%" fill="#eef2fb"/>${noise}${glyphs}</svg>`;
  return { text, svg };
}
