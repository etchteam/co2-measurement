import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  RATINGS,
  rate,
  badgeSvg,
  badgeFilename,
} from '../measure-co2.js';

test('rate() lower bound returns A+', () => {
  assert.equal(rate(0).grade, 'A+');
  assert.equal(rate(0.001).grade, 'A+');
});

test('rate() boundaries are inclusive on max', () => {
  for (const r of RATINGS) {
    if (r.max === Infinity) continue;
    assert.equal(rate(r.max).grade, r.grade, `g=${r.max} should be ${r.grade}`);
  }
});

test('rate() just above a boundary returns the next grade', () => {
  const boundaries = [
    [0.096, 'A'],
    [0.186, 'B'],
    [0.341, 'C'],
    [0.491, 'D'],
    [0.651, 'E'],
    [0.851, 'F'],
  ];
  for (const [g, grade] of boundaries) {
    assert.equal(rate(g).grade, grade, `g=${g} should be ${grade}`);
  }
});

test('rate() extreme values fall into F', () => {
  assert.equal(rate(10).grade, 'F');
  assert.equal(rate(1e6).grade, 'F');
});

test('badgeSvg() includes grade, grams and total transfer', () => {
  const svg = badgeSvg({ grams: 0.04, totalKB: 322.2, green: false });
  assert.match(svg, /0\.040g · A\+/);
  assert.match(svg, /322\.2 KB/);
  assert.match(svg, /CO₂\/visit/);
});

test('badgeSvg() appends green host suffix when green=true', () => {
  assert.match(
    badgeSvg({ grams: 0.04, totalKB: 100, green: true }),
    /green host/,
  );
  assert.doesNotMatch(
    badgeSvg({ grams: 0.04, totalKB: 100, green: false }),
    /green host/,
  );
});

test('badgeSvg() width grows with longer value strings', () => {
  const short = badgeSvg({ grams: 0.04, totalKB: 100, green: false });
  const long = badgeSvg({ grams: 0.04, totalKB: 100, green: true });
  const extract = (svg) => Number(svg.match(/<svg[^>]+width="([\d.]+)"/)[1]);
  assert.ok(extract(long) > extract(short));
});

test('badgeSvg() output parses as balanced XML', () => {
  const svg = badgeSvg({ grams: 0.34, totalKB: 500, green: true });
  assert.equal((svg.match(/</g) || []).length, (svg.match(/>/g) || []).length);
  assert.ok(svg.startsWith('<svg'));
  assert.ok(svg.endsWith('</svg>'));
});

test('badgeSvg() picks color matching the grade', () => {
  assert.match(badgeSvg({ grams: 0.05, totalKB: 1, green: false }), /#4c9a2a/);
  assert.match(badgeSvg({ grams: 10, totalKB: 1, green: false }), /#b32d0c/);
});

test('badgeFilename() slugifies host + pathname', () => {
  assert.equal(
    badgeFilename({ url: 'https://etch.co/blog/' }),
    'etch-co-blog.svg',
  );
  assert.equal(badgeFilename({ url: 'https://etch.co/' }), 'etch-co.svg');
  assert.equal(
    badgeFilename({ url: 'https://Example.COM/A/B' }),
    'example-com-a-b.svg',
  );
});
