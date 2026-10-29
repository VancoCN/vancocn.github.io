/* 验证骨架提取：压缩前后密度对比 + 可玩性判定
   单指持续敲击物理上限约 6~8 次/秒，可用区间目标 2~4 次/秒。 */
const fs = require('fs');
const path = require('path');
const ROOT = path.resolve(__dirname, '..');
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');

/* 载入骨架提取器（原型与这里共用同一份实现） */
const sandbox = {};
(new Function('window', read('dev/skeleton.js')))(sandbox);
const SK = sandbox.LAMDA_SKELETON;

const IDS = ['badapple', 'pupa', 'amidst-the-jungle', 'the-earth', 'the-field-of-hopes-and-dreams'];
const charts = {};
for (const id of IDS) {
  const w = { LAMBDA_CHART: {} };
  new Function('window', read('charts/' + id + '.js'))(w);
  charts[id] = w.LAMBDA_CHART[id];
}

console.log('骨架提取效果（minGap=' + SK.OPT.minGap + 's, holdMin=' + SK.OPT.holdMin + 's）\n');
console.log(
  '曲目'.padEnd(32) +
  '原taps'.padStart(8) + ' 骨架'.padStart(7) +
  '均值'.padStart(8) + '峰值'.padStart(7) +
  '  保留率'.padStart(8) + '  hold'.padStart(7) + '   可玩性'
);

const rows = [];
for (const id of IDS) {
  const c = charts[id];
  const sk = SK.skeleton(c);
  const d = SK.density(sk.notes, c.duration);
  const orig = SK.density(
    (c.notes[c.player || 0] || []).map((n) => ({ t: n[0] })).sort((a, b) => a.t - b.t),
    c.duration
  );
  let verdict;
  if (d.peak <= 7 && d.avg <= 4.2) verdict = '✅ 舒适';
  else if (d.peak <= 9) verdict = '⚠️ 偏紧';
  else verdict = '❌ 过密';

  rows.push({ id, orig, d, sk, verdict });
  console.log(
    id.padEnd(32) +
    String(c.taps).padStart(8) +
    String(sk.kept).padStart(7) +
    (d.avg.toFixed(2) + '/s').padStart(8) +
    (d.peak + '/s').padStart(7) +
    ((sk.kept / c.taps * 100).toFixed(0) + '%').padStart(8) +
    String(sk.holds).padStart(7) +
    '   ' + verdict
  );
}

console.log('\n压缩前对比（原谱面峰值）：');
for (const r of rows) {
  console.log('  ' + r.id.padEnd(32) +
    '原峰值 ' + String(r.orig.peak).padStart(3) + '/s' +
    ' → 骨架峰值 ' + String(r.d.peak).padStart(3) + '/s' +
    '   (>5/s 时间占比 ' + (r.orig.overRatio * 100).toFixed(0) + '% → ' + (r.d.overRatio * 100).toFixed(0) + '%)');
}

/* 检查骨架是否保住了旋律轮廓：相邻音的音高跳变分布 */
console.log('\n旋律轮廓保留情况（相邻保留音的音高差）：');
for (const r of rows) {
  const ns = r.sk.notes;
  const jumps = [];
  for (let i = 1; i < ns.length; i++) jumps.push(Math.abs(ns[i].pitch - ns[i - 1].pitch));
  jumps.sort((a, b) => a - b);
  const med = jumps[Math.floor(jumps.length / 2)] || 0;
  const big = jumps.filter((j) => j >= 2).length;
  console.log('  ' + r.id.padEnd(32) +
    '中位跳变 ' + med.toFixed(1) + ' 半音' +
    '  ≥2 半音的跳变 ' + (big / jumps.length * 100).toFixed(0) + '%' +
    '  音域 ' + r.sk.pLo.toFixed(0) + '~' + r.sk.pHi.toFixed(0));
}
