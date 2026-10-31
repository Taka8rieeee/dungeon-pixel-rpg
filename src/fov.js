'use strict';

/**
 * 递归阴影投射视野（8 象限），返回 Uint8Array 可见标记。
 * 只依赖 isOpaque 回调，不依赖具体地图结构。
 */
function computeFov(ox, oy, radius, isOpaque, w, h) {
  const visible = new Uint8Array(w * h);
  if (ox < 0 || oy < 0 || ox >= w || oy >= h) return visible;
  visible[oy * w + ox] = 1;

  const octants = [
    [1, 0, 0, 1],
    [0, 1, 1, 0],
    [0, -1, 1, 0],
    [-1, 0, 0, 1],
    [-1, 0, 0, -1],
    [0, -1, -1, 0],
    [0, 1, -1, 0],
    [1, 0, 0, -1],
  ];

  const cast = (row, start, end, xx, xy, yx, yy) => {
    if (start < end) return;
    let newStart = 0;
    for (let i = row; i <= radius; i++) {
      let dx = -i - 1;
      const dy = -i;
      let blocked = false;

      while (dx <= 0) {
        dx += 1;
        const X = ox + dx * xx + dy * xy;
        const Y = oy + dx * yx + dy * yy;
        const lSlope = (dx - 0.5) / (dy + 0.5);
        const rSlope = (dx + 0.5) / (dy - 0.5);

        if (start < rSlope) continue;
        if (end > lSlope) break;

        if (X >= 0 && Y >= 0 && X < w && Y < h) visible[Y * w + X] = 1;

        if (blocked) {
          if (isOpaque(X, Y)) {
            newStart = rSlope;
            continue;
          }
          blocked = false;
          start = newStart;
        } else if (isOpaque(X, Y) && i < radius) {
          blocked = true;
          cast(i + 1, start, lSlope, xx, xy, yx, yy);
          newStart = rSlope;
        }
      }
      if (blocked) break;
    }
  };

  for (const [xx, xy, yx, yy] of octants) cast(1, 1.0, 0.0, xx, xy, yx, yy);
  return visible;
}

module.exports = { computeFov };
