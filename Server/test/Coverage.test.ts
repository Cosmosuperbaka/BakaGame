import { expect, test } from 'bun:test';
import { parseLcov } from '../scripts/CheckCoverage';

test('覆盖率门禁累加单值计数而非误读行命中记录', () => {
  const report = 'SF:one.ts\nFNF:10\nFNH:8\nDA:1,6\nLF:100\nLH:90\nend_of_record\nSF:two.ts\nFNF:5\nFNH:4\nLF:20\nLH:10\nend_of_record';
  expect(parseLcov(report)).toEqual({ functionsFound: 15, functionsHit: 12, linesFound: 120, linesHit: 100 });
  expect(parseLcov('SF:missing.ts\nFNF:nan\nLF:none\nend_of_record')).toEqual({ functionsFound: 0, functionsHit: 0, linesFound: 0, linesHit: 0 });
});
