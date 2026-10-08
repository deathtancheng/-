/**
 * 氛围：飘浮的尘埃
 * ------------------------------------------------------------------
 * 一小撮光点在纸面上慢慢游，让画面「活」着。
 * 用 canvas 而不是 DOM，因为要跑 60fps 且元素多。
 * 这个模块和游戏状态完全无关，起一次就自己跑下去了。
 */

export function startMotes(canvas) {
  if (!canvas) return;
  const g = canvas.getContext('2d');
  let W, H;
  let dots = [];
  const COUNT = 46;

  function resize() {
    W = canvas.width = window.innerWidth;
    H = canvas.height = window.innerHeight;
    dots = Array.from({ length: COUNT }, () => ({
      x: Math.random() * W,
      y: Math.random() * H,
      r: Math.random() * 1.7 + 0.5,
      vx: (Math.random() - 0.5) * 0.16,
      vy: -Math.random() * 0.2 - 0.04,
      a: Math.random() * 0.32 + 0.08,
      ph: Math.random() * Math.PI * 2,
    }));
  }

  function tick(t) {
    g.clearRect(0, 0, W, H);
    for (const d of dots) {
      d.x += d.vx;
      d.y += d.vy;
      if (d.y < -6) { d.y = H + 6; d.x = Math.random() * W; }
      if (d.x < -6) d.x = W + 6;
      if (d.x > W + 6) d.x = -6;
      // 呼吸般的明暗
      const alpha = d.a * (0.6 + 0.4 * Math.sin(t / 1400 + d.ph));
      g.beginPath();
      g.arc(d.x, d.y, d.r, 0, Math.PI * 2);
      g.fillStyle = `rgba(126, 155, 110, ${alpha})`;
      g.fill();
    }
    requestAnimationFrame(tick);
  }

  resize();
  window.addEventListener('resize', resize);
  requestAnimationFrame(tick);
}
