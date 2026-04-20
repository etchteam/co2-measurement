import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  GRADE_COLORS,
  badgeSvg,
  badgeFilename,
  averagePerVisitGrams,
  parseTarget,
} from '../measure-co2.js';

test('badgeSvg() includes grade, grams and total transfer', () => {
  const svg = badgeSvg({
    grams: 0.04,
    rating: 'A+',
    totalKB: 322.2,
    green: false,
  });
  assert.match(svg, /0\.040g · A\+/);
  assert.match(svg, /322\.2 KB/);
  assert.match(svg, /CO₂\/visit/);
});

test('badgeSvg() appends green host suffix when green=true', () => {
  assert.match(
    badgeSvg({ grams: 0.04, rating: 'A+', totalKB: 100, green: true }),
    /green host/,
  );
  assert.doesNotMatch(
    badgeSvg({ grams: 0.04, rating: 'A+', totalKB: 100, green: false }),
    /green host/,
  );
});

test('badgeSvg() width grows with longer value strings', () => {
  const short = badgeSvg({
    grams: 0.04,
    rating: 'A+',
    totalKB: 100,
    green: false,
  });
  const long = badgeSvg({
    grams: 0.04,
    rating: 'A+',
    totalKB: 100,
    green: true,
  });
  const extract = (svg) => Number(svg.match(/<svg[^>]+width="([\d.]+)"/)[1]);
  assert.ok(extract(long) > extract(short));
});

test('badgeSvg() output parses as balanced XML', () => {
  const svg = badgeSvg({
    grams: 0.34,
    rating: 'C',
    totalKB: 500,
    green: true,
  });
  assert.equal((svg.match(/</g) || []).length, (svg.match(/>/g) || []).length);
  assert.ok(svg.startsWith('<svg'));
  assert.ok(svg.endsWith('</svg>'));
});

test('badgeSvg() picks color matching the grade', () => {
  assert.match(
    badgeSvg({ grams: 0.05, rating: 'A+', totalKB: 1, green: false }),
    new RegExp(GRADE_COLORS['A+']),
  );
  assert.match(
    badgeSvg({ grams: 10, rating: 'F', totalKB: 1, green: false }),
    new RegExp(GRADE_COLORS.F),
  );
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

test('averagePerVisitGrams() means successful results', () => {
  assert.equal(
    averagePerVisitGrams([{ perVisitGrams: 0.04 }, { perVisitGrams: 0.08 }]),
    0.06,
  );
});

test('averagePerVisitGrams() ignores errored results', () => {
  assert.equal(
    averagePerVisitGrams([
      { perVisitGrams: 0.04 },
      { url: 'x', error: 'boom' },
      { perVisitGrams: 0.06 },
    ]),
    0.05,
  );
});

test('averagePerVisitGrams() returns null when no successes', () => {
  assert.equal(averagePerVisitGrams([{ error: 'x' }]), null);
  assert.equal(averagePerVisitGrams([]), null);
});

test('parseTarget() splits name=url into archetype and url', () => {
  assert.deepEqual(parseTarget('home=https://etch.co/'), {
    name: 'home',
    url: 'https://etch.co/',
  });
  assert.deepEqual(parseTarget('blog-index=https://etch.co/blog/'), {
    name: 'blog-index',
    url: 'https://etch.co/blog/',
  });
});

test('parseTarget() treats bare URLs as anonymous', () => {
  assert.deepEqual(parseTarget('https://etch.co/'), {
    name: null,
    url: 'https://etch.co/',
  });
});

test('parseTarget() rejects invalid archetype names', () => {
  assert.deepEqual(parseTarget('Home=https://etch.co/'), {
    name: null,
    url: 'Home=https://etch.co/',
  });
});

test('parseTarget() rejects non-http URLs after name=', () => {
  assert.deepEqual(parseTarget('home=not-a-url'), {
    name: null,
    url: 'home=not-a-url',
  });
});
